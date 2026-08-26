import { fail } from '@sveltejs/kit';
import { addApiKey, listApiKeys, deleteApiKey } from '$lib/server/service/api-service';
import { getDomains } from '$lib/server/service/domain-service';
import { requireDomainId, requireTeamId } from '$lib/server/dashboard';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const teamId = requireTeamId(locals.teamId);
	if (!locals.domainId) {
		return {
			needsDomain: true as const,
			keys: [],
			domains: [],
			currentDomainId: null as number | null,
		};
	}
	const domains = await getDomains(teamId);
	const domainNameById = new Map(domains.map((d) => [d.id, d.name]));
	const keys = (await listApiKeys(teamId, locals.domainId)).map((key) => ({
		...key,
		domainLabel:
			key.domainId == null
				? 'All domains'
				: (domainNameById.get(key.domainId) ?? `domain #${key.domainId}`),
	}));
	return {
		needsDomain: false as const,
		keys,
		domains,
		currentDomainId: locals.domainId,
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const teamId = requireTeamId(locals.teamId);
		requireDomainId(locals.domainId);
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const permission = String(form.get('permission') ?? 'FULL') as 'FULL' | 'SENDING';
		const domainRaw = String(form.get('domainId') ?? '').trim();

		// Empty select = all domains (null). Never silently fall back to the
		// domain switcher — that ignored the dropdown and bound keys wrong.
		let domainId: number | undefined;
		if (domainRaw !== '') {
			domainId = Number(domainRaw);
			if (!Number.isFinite(domainId)) {
				return fail(400, { error: 'Invalid domain' });
			}
		}

		if (!name) return fail(400, { error: 'Name required' });
		try {
			const key = await addApiKey({ name, permission, teamId, domainId });
			return { newKey: key };
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Failed' });
		}
	},
	delete: async ({ request, locals }) => {
		const teamId = requireTeamId(locals.teamId);
		const domainId = requireDomainId(locals.domainId);
		const id = Number((await request.formData()).get('id'));
		const keys = await listApiKeys(teamId, domainId);
		if (keys.some((k) => k.id === id)) {
			await deleteApiKey(id);
		}
	},
};
