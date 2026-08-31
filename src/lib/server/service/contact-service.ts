import { and, desc, eq, inArray, like, lt } from 'drizzle-orm';
import { cuid, nowIso, parseJsonObject } from '$lib/utils';
import { db } from '../db';
import { contactBooks, contacts, type UnsubscribeReason } from '../db/schema';
import { enqueue } from '../queue';
import { QUEUES } from '../queue/constants';
import * as webhookService from './webhook-service';
import type { ContactPayload, ContactWebhookEventType } from '../webhook-events';
import { sendDoubleOptInConfirmationEmail, type DoiSendResult } from './double-opt-in-service';

export type AddOrUpdateContactResult = Contact & {
	doiSent?: boolean;
	doiError?: string | null;
};

export type Contact = typeof contacts.$inferSelect;

export type ContactInput = {
	email: string;
	firstName?: string | null;
	lastName?: string | null;
	properties?: Record<string, unknown>;
	subscribed?: boolean;
	/**
	 * Caller asserts the address is already verified through its own double
	 * opt-in. Skips the contact book's DOI email and stores the contact as
	 * subscribed. Never re-subscribes an existing unsubscribed contact.
	 */
	emailConfirmed?: boolean;
};

function buildContactPayload(contact: Contact): ContactPayload {
	return {
		id: contact.id,
		email: contact.email,
		contactBookId: contact.contactBookId,
		subscribed: contact.subscribed,
		properties: parseJsonObject(contact.properties),
		firstName: contact.firstName,
		lastName: contact.lastName,
		createdAt: contact.createdAt,
		updatedAt: contact.updatedAt,
	};
}

async function emitContactEvent(
	contact: Contact,
	type: ContactWebhookEventType,
	teamId?: number,
): Promise<void> {
	try {
		const resolvedTeamId =
			teamId ??
			db
				.select({ teamId: contactBooks.teamId })
				.from(contactBooks)
				.where(eq(contactBooks.id, contact.contactBookId))
				.get()?.teamId;

		if (!resolvedTeamId) {
			return;
		}

		await webhookService.emit(resolvedTeamId, type, buildContactPayload(contact));
	} catch (error) {
		console.error('[contact] Failed to emit contact webhook event', {
			contactId: contact.id,
			type,
			error,
		});
	}
}

export function getContactInContactBook(contactId: string, contactBookId: string): Contact | null {
	return (
		db
			.select()
			.from(contacts)
			.where(and(eq(contacts.id, contactId), eq(contacts.contactBookId, contactBookId)))
			.get() ?? null
	);
}

/** First contact matching `email` in any contact book owned by `teamId`. */
export function findContactByEmailForTeam(teamId: number, email: string): Contact | null {
	const normalized = email.trim().toLowerCase();
	if (!normalized) return null;

	const row = db
		.select({ contact: contacts })
		.from(contacts)
		.innerJoin(contactBooks, eq(contacts.contactBookId, contactBooks.id))
		.where(and(eq(contactBooks.teamId, teamId), eq(contacts.email, normalized)))
		.get();

	return row?.contact ?? null;
}

export type ListContactsParams = {
	contactBookId: string;
	search?: string;
	subscribed?: boolean;
	limit?: number;
	cursor?: string;
};

export function listContacts(params: ListContactsParams): {
	items: Contact[];
	nextCursor: string | null;
} {
	const limit = params.limit ?? 30;
	const conditions = [eq(contacts.contactBookId, params.contactBookId)];
	if (params.search) {
		conditions.push(like(contacts.email, `%${params.search}%`));
	}
	if (params.subscribed !== undefined) {
		conditions.push(eq(contacts.subscribed, params.subscribed));
	}
	if (params.cursor) {
		conditions.push(lt(contacts.id, params.cursor));
	}

	const rows = db
		.select()
		.from(contacts)
		.where(and(...conditions))
		.orderBy(desc(contacts.id))
		.limit(limit + 1)
		.all();

	let nextCursor: string | null = null;
	if (rows.length > limit) {
		const next = rows.pop();
		nextCursor = next?.id ?? null;
	}

	return { items: rows, nextCursor };
}

/**
 * Insert or update a contact. Applies double opt-in rules: new subscribers in
 * double opt-in books start unsubscribed until they confirm, and re-subscribe
 * attempts through bulk import are ignored. `emailConfirmed: true` marks a new
 * contact as pre-verified by the caller (own double opt-in) so it is stored
 * subscribed without sending the DOI email.
 */
export async function addOrUpdateContact(
	contactBookId: string,
	contact: ContactInput,
	teamId?: number,
): Promise<AddOrUpdateContactResult> {
	const contactBook = db
		.select({ teamId: contactBooks.teamId, doubleOptInEnabled: contactBooks.doubleOptInEnabled })
		.from(contactBooks)
		.where(eq(contactBooks.id, contactBookId))
		.get();

	if (!contactBook) {
		throw new Error('Contact book not found');
	}

	const email = contact.email.toLowerCase().trim();

	const existing = db
		.select()
		.from(contacts)
		.where(and(eq(contacts.contactBookId, contactBookId), eq(contacts.email, email)))
		.get();

	const isExplicitUnsubscribe = contact.subscribed === false;
	const isPreConfirmed = contact.emailConfirmed === true;

	const shouldSendDoubleOptIn =
		contactBook.doubleOptInEnabled &&
		!isExplicitUnsubscribe &&
		!isPreConfirmed &&
		(!existing || (!existing.subscribed && existing.unsubscribeReason === null));

	const shouldCreatePending =
		contactBook.doubleOptInEnabled &&
		existing === undefined &&
		!isExplicitUnsubscribe &&
		!isPreConfirmed;

	let saved: Contact;

	if (!existing) {
		saved = db
			.insert(contacts)
			.values({
				id: cuid(),
				contactBookId,
				email,
				firstName: contact.firstName ?? null,
				lastName: contact.lastName ?? null,
				properties: JSON.stringify(contact.properties ?? {}),
				subscribed: shouldCreatePending ? false : (contact.subscribed ?? true),
				unsubscribeReason: shouldCreatePending
					? null
					: contact.subscribed === false
						? 'UNSUBSCRIBED'
						: null,
			})
			.returning()
			.get();
	} else {
		// Block No -> Yes transition via import; allow all others.
		let subscribedValue = contact.subscribed;
		if (subscribedValue !== undefined && !existing.subscribed && subscribedValue) {
			subscribedValue = undefined;
		}

		const mergedProperties =
			contact.properties === undefined
				? undefined
				: { ...parseJsonObject(existing.properties), ...contact.properties };

		saved = db
			.update(contacts)
			.set({
				firstName: contact.firstName ?? existing.firstName,
				lastName: contact.lastName ?? existing.lastName,
				...(mergedProperties !== undefined ? { properties: JSON.stringify(mergedProperties) } : {}),
				...(subscribedValue !== undefined
					? {
							subscribed: subscribedValue,
							unsubscribeReason: subscribedValue ? null : ('UNSUBSCRIBED' as UnsubscribeReason),
						}
					: {}),
				updatedAt: nowIso(),
			})
			.where(eq(contacts.id, existing.id))
			.returning()
			.get();
	}

	let doiResult: DoiSendResult | null = null;

	if (shouldSendDoubleOptIn) {
		try {
			doiResult = await sendDoubleOptInConfirmationEmail({
				contactId: saved.id,
				contactBookId,
				teamId: teamId ?? contactBook.teamId,
			});
		} catch (error) {
			doiResult = { sent: false, reason: error instanceof Error ? error.message : String(error) };
			console.error('[contact] Failed to send double opt-in confirmation email', {
				contactId: saved.id,
				error,
			});
		}
	}

	await emitContactEvent(saved, existing ? 'contact.updated' : 'contact.created', teamId);

	if (!existing && saved.subscribed) {
		try {
			const { handleContactCreated } = await import('./flow-engine');
			handleContactCreated({
				id: saved.id,
				email: saved.email,
				contactBookId,
				teamId: teamId ?? contactBook.teamId,
			});
		} catch (error) {
			console.error('[contact] Failed to enroll contact in automation flows', {
				contactId: saved.id,
				error,
			});
		}
	}

	return Object.assign(saved, {
		doiSent: doiResult?.sent ?? false,
		doiError: doiResult?.reason ?? null,
	});
}

export async function updateContactInContactBook(
	contactId: string,
	contactBookId: string,
	contact: Partial<ContactInput>,
	teamId?: number,
): Promise<Contact | null> {
	const existing = getContactInContactBook(contactId, contactBookId);
	if (!existing) {
		return null;
	}

	const mergedProperties =
		contact.properties === undefined
			? undefined
			: { ...parseJsonObject(existing.properties), ...contact.properties };

	const updated = db
		.update(contacts)
		.set({
			...(contact.email !== undefined ? { email: contact.email.toLowerCase().trim() } : {}),
			...(contact.firstName !== undefined ? { firstName: contact.firstName } : {}),
			...(contact.lastName !== undefined ? { lastName: contact.lastName } : {}),
			...(mergedProperties !== undefined ? { properties: JSON.stringify(mergedProperties) } : {}),
			...(contact.subscribed !== undefined
				? {
						subscribed: contact.subscribed,
						unsubscribeReason: contact.subscribed ? null : ('UNSUBSCRIBED' as UnsubscribeReason),
					}
				: {}),
			updatedAt: nowIso(),
		})
		.where(eq(contacts.id, contactId))
		.returning()
		.get();

	await emitContactEvent(updated, 'contact.updated', teamId);

	return updated;
}

export async function deleteContactInContactBook(
	contactId: string,
	contactBookId: string,
	teamId?: number,
): Promise<Contact | null> {
	const existing = getContactInContactBook(contactId, contactBookId);
	if (!existing) {
		return null;
	}

	db.delete(contacts).where(eq(contacts.id, contactId)).run();

	await emitContactEvent(existing, 'contact.deleted', teamId);

	return existing;
}

export async function bulkDeleteContactsInContactBook(
	contactIds: string[],
	contactBookId: string,
	teamId?: number,
): Promise<Contact[]> {
	if (contactIds.length === 0) return [];

	const rows = db
		.select()
		.from(contacts)
		.where(and(inArray(contacts.id, contactIds), eq(contacts.contactBookId, contactBookId)))
		.all();

	if (rows.length === 0) return [];

	db.delete(contacts)
		.where(
			and(
				inArray(
					contacts.id,
					rows.map((c) => c.id),
				),
				eq(contacts.contactBookId, contactBookId),
			),
		)
		.run();

	for (const contact of rows) {
		await emitContactEvent(contact, 'contact.deleted', teamId);
	}

	return rows;
}

export type BulkContactJobPayload = {
	contactBookId: string;
	contacts: ContactInput[];
	teamId?: number;
};

/**
 * Queue a batch of contacts for asynchronous upsert processing.
 */
export function bulkAddContacts(
	contactBookId: string,
	contactList: ContactInput[],
	teamId?: number,
): { message: string; count: number } {
	if (contactList.length > 0) {
		const payload: BulkContactJobPayload = { contactBookId, contacts: contactList, teamId };
		enqueue(QUEUES.CONTACT_BULK_ADD, payload);
	}

	return {
		message: `Queued ${contactList.length} contacts for processing`,
		count: contactList.length,
	};
}

/**
 * Queue handler for {@link QUEUES.CONTACT_BULK_ADD}.
 */
export async function processContactBulkAdd(payload: unknown): Promise<void> {
	const { contactBookId, contacts: contactList, teamId } = (payload ?? {}) as BulkContactJobPayload;
	if (!contactBookId || !Array.isArray(contactList)) return;

	for (const contact of contactList) {
		try {
			await addOrUpdateContact(contactBookId, contact, teamId);
		} catch (error) {
			console.error('[contact] Failed to process bulk contact', { email: contact.email, error });
		}
	}
}

export async function updateContactSubscription({
	contactId,
	subscribed,
	unsubscribeReason,
	teamId,
}: {
	contactId: string;
	subscribed: boolean;
	unsubscribeReason: UnsubscribeReason | null;
	teamId?: number;
}): Promise<Contact> {
	const updated = db
		.update(contacts)
		.set({ subscribed, unsubscribeReason, updatedAt: nowIso() })
		.where(eq(contacts.id, contactId))
		.returning()
		.get();

	await emitContactEvent(updated, 'contact.updated', teamId);

	return updated;
}

export function unsubscribeContact(contactId: string): void {
	db.update(contacts)
		.set({ subscribed: false, unsubscribeReason: 'UNSUBSCRIBED', updatedAt: nowIso() })
		.where(eq(contacts.id, contactId))
		.run();
}

export function subscribeContact(contactId: string): void {
	db.update(contacts)
		.set({ subscribed: true, unsubscribeReason: null, updatedAt: nowIso() })
		.where(eq(contacts.id, contactId))
		.run();
}
