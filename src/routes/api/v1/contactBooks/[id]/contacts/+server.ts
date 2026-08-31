import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { parseJsonObject } from '$lib/utils';
import { requireApiTeam } from '$lib/server/api/auth';
import { parseBody } from '$lib/server/api/validate';
import { jsonErrorFromException } from '$lib/server/api/errors';
import { getContactBook } from '$lib/server/service/contact-book-service';
import { addOrUpdateContact, listContacts } from '$lib/server/service/contact-service';

const contactSchema = z.object({
	email: z.string(),
	firstName: z.string().optional(),
	lastName: z.string().optional(),
	properties: z.record(z.string(), z.unknown()).optional(),
	subscribed: z.boolean().optional(),
	/** Caller-verified address (own double opt-in): skip DOI email, store subscribed. */
	emailConfirmed: z.boolean().optional(),
});

function serializeContact(contact: {
	id: string;
	email: string;
	firstName: string | null;
	lastName: string | null;
	subscribed: boolean;
	properties: string;
	contactBookId: string;
	createdAt: string;
	updatedAt: string;
}) {
	return {
		...contact,
		properties: parseJsonObject(contact.properties),
	};
}

export const GET: RequestHandler = async ({ request, params, url }) => {
	const { team } = await requireApiTeam(request);
	try {
		getContactBook(params.id, team.id);
	} catch (error) {
		return jsonErrorFromException(error);
	}

	const search = url.searchParams.get('search') ?? undefined;
	const subscribedParam = url.searchParams.get('subscribed');
	const subscribed =
		subscribedParam === 'true' ? true : subscribedParam === 'false' ? false : undefined;
	const limit = url.searchParams.get('limit');
	const cursor = url.searchParams.get('cursor') ?? undefined;

	const result = listContacts({
		contactBookId: params.id,
		search,
		subscribed,
		limit: limit ? Number(limit) : undefined,
		cursor,
	});

	return json({
		data: result.items.map(serializeContact),
		nextCursor: result.nextCursor,
	});
};

export const POST: RequestHandler = async ({ request, params }) => {
	const { team } = await requireApiTeam(request);
	try {
		getContactBook(params.id, team.id);
	} catch (error) {
		return jsonErrorFromException(error);
	}

	const input = await parseBody(request, contactSchema);
	try {
		const contact = await addOrUpdateContact(params.id, input, team.id);
		return json({ contactId: contact.id });
	} catch (error) {
		return jsonErrorFromException(error);
	}
};
