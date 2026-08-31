import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { resetDb } from '../../../tests/helpers/db';
import { createTeam, createContactBook, createContact } from '../../../tests/helpers/factories';
import {
	addOrUpdateContact,
	listContacts,
	deleteContactInContactBook,
	bulkDeleteContactsInContactBook,
	bulkAddContacts,
} from './contact-service';
import { db } from '../db';
import { contacts, emails, queueJobs } from '../db/schema';
import { QUEUES } from '../queue/constants';

describe('contact-service', () => {
	beforeEach(() => resetDb());

	it('addOrUpdateContact inserts and upserts contacts', async () => {
		const team = createTeam();
		const book = createContactBook(team.id, { doubleOptInEnabled: false });

		const created = await addOrUpdateContact(
			book.id,
			{
				email: '  User@Example.COM ',
				firstName: 'Ada',
				lastName: 'Lovelace',
				properties: { plan: 'pro' },
			},
			team.id,
		);

		expect(created.email).toBe('user@example.com');
		expect(created.firstName).toBe('Ada');
		expect(JSON.parse(created.properties)).toEqual({ plan: 'pro' });

		const updated = await addOrUpdateContact(
			book.id,
			{
				email: 'user@example.com',
				firstName: 'Augusta',
				properties: { tier: 'gold' },
			},
			team.id,
		);

		expect(updated.id).toBe(created.id);
		expect(updated.firstName).toBe('Augusta');
		expect(JSON.parse(updated.properties)).toEqual({ plan: 'pro', tier: 'gold' });
	});

	it('addOrUpdateContact stores emailConfirmed contacts subscribed without DOI email', async () => {
		const team = createTeam();
		const book = createContactBook(team.id, { doubleOptInEnabled: true });

		const created = await addOrUpdateContact(
			book.id,
			{
				email: 'Verified@Example.com',
				emailConfirmed: true,
			},
			team.id,
		);

		expect(created.subscribed).toBe(true);
		expect(created.unsubscribeReason).toBeNull();
		expect(db.select().from(emails).all()).toHaveLength(0);
	});

	it('addOrUpdateContact keeps DOI pending flow without emailConfirmed', async () => {
		const team = createTeam();
		const book = createContactBook(team.id, { doubleOptInEnabled: true });

		const created = await addOrUpdateContact(book.id, { email: 'pending@example.com' }, team.id);

		expect(created.subscribed).toBe(false);
		expect(created.unsubscribeReason).toBeNull();
	});

	it('addOrUpdateContact does not re-subscribe unsubscribed contacts via emailConfirmed', async () => {
		const team = createTeam();
		const book = createContactBook(team.id, { doubleOptInEnabled: true });
		const contact = createContact(book.id, {
			email: 'gone@example.com',
			subscribed: false,
			unsubscribeReason: 'UNSUBSCRIBED',
		});

		const updated = await addOrUpdateContact(
			book.id,
			{ email: 'gone@example.com', emailConfirmed: true },
			team.id,
		);

		expect(updated.id).toBe(contact.id);
		expect(updated.subscribed).toBe(false);
		expect(updated.unsubscribeReason).toBe('UNSUBSCRIBED');
	});

	it('listContacts supports search and cursor pagination', async () => {
		const team = createTeam();
		const book = createContactBook(team.id, { doubleOptInEnabled: false });
		createContact(book.id, { email: 'alpha@test.com' });
		createContact(book.id, { email: 'beta@test.com' });
		createContact(book.id, { email: 'gamma@test.com' });
		createContact(book.id, { email: 'delta@test.com' });
		createContact(book.id, { email: 'epsilon@test.com' });

		const search = listContacts({ contactBookId: book.id, search: 'beta' });
		expect(search.items).toHaveLength(1);
		expect(search.items[0].email).toBe('beta@test.com');

		const page1 = listContacts({ contactBookId: book.id, limit: 2 });
		expect(page1.items).toHaveLength(2);
		expect(page1.nextCursor).toBeTruthy();

		const page2 = listContacts({
			contactBookId: book.id,
			limit: 2,
			cursor: page1.nextCursor!,
		});
		expect(page2.items.length).toBeGreaterThanOrEqual(1);

		const allEmails = [...page1.items, ...page2.items].map((c) => c.email);
		expect(new Set(allEmails).size).toBe(allEmails.length);
	});

	it('deleteContactInContactBook removes a contact', async () => {
		const team = createTeam();
		const book = createContactBook(team.id, { doubleOptInEnabled: false });
		const contact = createContact(book.id);

		const deleted = await deleteContactInContactBook(contact.id, book.id, team.id);

		expect(deleted?.id).toBe(contact.id);
		expect(
			db
				.select()
				.from(contacts)
				.where(and(eq(contacts.id, contact.id), eq(contacts.contactBookId, book.id)))
				.get(),
		).toBeUndefined();
	});

	it('bulkDeleteContactsInContactBook deletes by contact ids', async () => {
		const team = createTeam();
		const book = createContactBook(team.id, { doubleOptInEnabled: false });
		const keep = createContact(book.id, { email: 'keep@test.com' });
		const remove1 = createContact(book.id, { email: 'remove1@test.com' });
		const remove2 = createContact(book.id, { email: 'remove2@test.com' });

		const deleted = await bulkDeleteContactsInContactBook(
			[remove1.id, remove2.id],
			book.id,
			team.id,
		);

		expect(deleted).toHaveLength(2);
		expect(db.select().from(contacts).where(eq(contacts.contactBookId, book.id)).all()).toEqual([
			expect.objectContaining({ id: keep.id }),
		]);
	});

	it('bulkDeleteContactsInContactBook deletes by resolved email addresses', async () => {
		const team = createTeam();
		const book = createContactBook(team.id, { doubleOptInEnabled: false });
		createContact(book.id, { email: 'keep@test.com' });
		const remove = createContact(book.id, { email: 'remove@test.com' });

		const emails = ['Remove@Test.COM'];
		const rows = db
			.select({ id: contacts.id })
			.from(contacts)
			.where(
				and(
					eq(contacts.contactBookId, book.id),
					inArray(
						contacts.email,
						emails.map((e) => e.toLowerCase().trim()),
					),
				),
			)
			.all();

		const deleted = await bulkDeleteContactsInContactBook(
			rows.map((r) => r.id),
			book.id,
			team.id,
		);

		expect(deleted).toHaveLength(1);
		expect(deleted[0].id).toBe(remove.id);
	});

	it('bulkAddContacts enqueues a contact bulk add job', () => {
		const team = createTeam();
		const book = createContactBook(team.id, { doubleOptInEnabled: false });

		const result = bulkAddContacts(
			book.id,
			[
				{ email: 'one@test.com', firstName: 'One' },
				{ email: 'two@test.com', firstName: 'Two' },
			],
			team.id,
		);

		expect(result.count).toBe(2);
		expect(result.message).toContain('Queued 2 contacts');

		const jobs = db
			.select()
			.from(queueJobs)
			.where(eq(queueJobs.queue, QUEUES.CONTACT_BULK_ADD))
			.all();
		expect(jobs).toHaveLength(1);

		const payload = JSON.parse(jobs[0].payload);
		expect(payload.contactBookId).toBe(book.id);
		expect(payload.teamId).toBe(team.id);
		expect(payload.contacts).toHaveLength(2);
	});
});
