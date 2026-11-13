import {
	abortUpload,
	beginUpload,
	commitUpload,
	pagedCeiling,
	putPart,
	RestorePartsError,
	uploadStatus,
	type UploadStatus
} from '../../db/restore-parts';
import { MARK_ID, noteRestoreMark } from '../../db/write-mark';
import { DEFAULT_MAX_PAGED_RESTORE_BYTES, RESTORE_PART_MAX_BYTES } from '../../ops/body-limit';
import type { SitePhpDurableObject } from '../../site-do';
import { errorMessage } from '../../util/errors';
import { jsonError } from '../../util/reply';

/** the part body, counted as it arrives; one part is the most this route ever holds */
async function readPartBody(request: Request): Promise<Uint8Array> {
	const tooLarge = () =>
		new RestorePartsError(
			'too_large',
			413,
			`a part is at most ${RESTORE_PART_MAX_BYTES} bytes`,
			{
				limit: RESTORE_PART_MAX_BYTES
			}
		);
	const declared = Number(request.headers.get('content-length') ?? '');
	if (Number.isFinite(declared) && declared > RESTORE_PART_MAX_BYTES) throw tooLarge();
	if (request.body === null) return new Uint8Array(0);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > RESTORE_PART_MAX_BYTES) {
			await reader.cancel();
			throw tooLarge();
		}
		chunks.push(value);
	}
	const whole = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		whole.set(chunk, at);
		at += chunk.byteLength;
	}
	return whole;
}

function statusBody(status: UploadStatus): Record<string, unknown> {
	return {
		upload: status.id,
		state: status.state,
		label: status.generation,
		bytes: status.bytes,
		parts: status.parts,
		sha256: status.sha256,
		receivedParts: status.receivedParts,
		bytesReceived: status.bytesReceived,
		assembledParts: status.assembledParts,
		expiresAt: status.expiresAt,
		maxPartBytes: RESTORE_PART_MAX_BYTES
	};
}

/**
 * A restore sent in parts: `action=begin|put|commit|abort|status`.
 *
 * `begin` declares the dump, `put` stores one statement-aligned part, `commit` verifies the whole
 * digest and assembles the replay chunks over one or more calls, `abort` removes everything, and
 * `status` says which parts the site holds.
 */
export async function restoreParts(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const action = url.searchParams.get('action') ?? 'status';
	const uploadId = url.searchParams.get('upload') ?? '';
	const nowMs = site.nowMs();
	const sql = site.sql;
	const storage = site.storage;
	const needs = (method: string): Response | undefined =>
		request.method === method ? undefined : jsonError(`${action} takes ${method}`, 405);

	try {
		switch (action) {
			case 'begin': {
				const refused = needs('POST');
				if (refused) return refused;
				let declared: {
					bytes?: unknown;
					parts?: unknown;
					sha256?: unknown;
					label?: unknown;
				};
				try {
					declared = JSON.parse(await request.text());
				} catch {
					return jsonError('send the declaration as JSON', 400, { code: 'bad_request' });
				}
				const { status, created } = beginUpload(sql, storage, {
					label: String(declared.label ?? url.searchParams.get('label') ?? nowMs),
					bytes: Number(declared.bytes),
					parts: Number(declared.parts),
					sha256: String(declared.sha256 ?? ''),
					nowMs,
					maxBytes: pagedCeiling(
						site.env?.MAX_RESTORE_PAGED_BYTES,
						DEFAULT_MAX_PAGED_RESTORE_BYTES
					)
				});
				return Response.json({ ok: true, created, ...statusBody(status) });
			}
			case 'put': {
				if (request.method !== 'PUT' && request.method !== 'POST') {
					return jsonError('put takes PUT', 405);
				}
				const part = Number(url.searchParams.get('part') ?? '');
				const { stored, status } = putPart(sql, storage, {
					id: uploadId,
					part,
					body: await readPartBody(request),
					sha256: request.headers.get('x-part-sha256') ?? '',
					nowMs
				});
				return Response.json({ ok: true, part, stored, ...statusBody(status) });
			}
			case 'commit': {
				const refused = needs('POST');
				if (refused) return refused;
				const mark = url.searchParams.get('mark');
				if (mark !== null && !MARK_ID.test(mark)) {
					return jsonError('mark must be 1 to 64 letters, digits or _.:-', 400, {
						code: 'bad_request'
					});
				}
				if (mark !== null && site.isReplica()) {
					return jsonError('a replica lane keeps no mark', 409);
				}
				const result = commitUpload(sql, storage, { id: uploadId, nowMs });
				// noted under the label the upload was declared with, which the import carries
				const label = result.done
					? result.import.generation
					: uploadStatus(sql, storage, nowMs, uploadId)?.generation;
				if (mark !== null && label !== undefined) noteRestoreMark(sql, label, mark);
				const named = mark === null ? {} : { mark };
				if (!result.done) return Response.json({ ok: true, ...result, ...named });
				await site.setAlarmAt(site.nowMs() + 1);
				return Response.json({
					ok: true,
					done: true,
					id: result.import.id,
					chunks: result.import.chunks,
					statements: result.import.statements,
					generation: result.import.generation,
					...named
				});
			}
			case 'abort': {
				const refused = needs('POST');
				if (refused) return refused;
				return Response.json({ ok: true, aborted: abortUpload(sql, storage, uploadId) });
			}
			case 'status': {
				const status = uploadStatus(sql, storage, nowMs, uploadId || undefined);
				return Response.json({
					ok: true,
					...(status === undefined ? { upload: null } : statusBody(status))
				});
			}
			default:
				return jsonError('action is begin, put, commit, abort or status', 400, {
					code: 'bad_request'
				});
		}
	} catch (e) {
		if (e instanceof RestorePartsError) {
			return jsonError(e.message, e.status, { code: e.code, ...e.extra });
		}
		if (errorMessage(e).includes('SQLITE_FULL')) {
			return jsonError('the site has no storage left for this restore', 507, {
				code: 'storage_full'
			});
		}
		throw e;
	}
}
