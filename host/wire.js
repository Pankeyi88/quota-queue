/**
 * quota-queue/host — request envelope and payload validation.
 *
 * request = `{version:1, op:string, requestId:string, payload:object}`.
 * The envelope has exactly those four fields. The payload has exactly the
 * fields its op declares, each a primitive of the declared type.
 *
 * Nothing here trusts a caller-supplied notion of identity: there is no
 * `actor`, `role` or capability field, and such a field is refused by name.
 */
import { isPlainObject, isNonEmptyString } from '../core/util.mjs';
import { DENIED_PAYLOAD_FIELDS, OPS, PAYLOAD_SPECS, WIRE_VERSION } from './constants.js';
import { HostError } from './errors.js';

const ENVELOPE_KEYS = Object.freeze(['version', 'op', 'requestId', 'payload']);
const DENIED = new Set(DENIED_PAYLOAD_FIELDS);
const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Validate the request envelope.
 * @param {unknown} raw
 * @returns {{version:number, op:string, requestId:string, payload:object}}
 * @throws {HostError} invalid_request
 */
export function parseRequest(raw) {
  if (!isPlainObject(raw)) throw new HostError('invalid_request', { field: 'request' });
  const keys = Object.keys(raw);
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((key) => !ENVELOPE_KEYS.includes(key))) {
    throw new HostError('invalid_request', { field: 'envelope' });
  }
  if (raw.version !== WIRE_VERSION) throw new HostError('invalid_request', { field: 'version' });
  if (!isNonEmptyString(raw.op) || !OPS.includes(raw.op)) throw new HostError('unknown_op', { op: raw.op });
  if (typeof raw.requestId !== 'string' || !REQUEST_ID_RE.test(raw.requestId)) {
    throw new HostError('invalid_request', { field: 'requestId' });
  }
  if (!isPlainObject(raw.payload)) throw new HostError('invalid_request', { field: 'payload' });
  return { version: raw.version, op: raw.op, requestId: raw.requestId, payload: raw.payload };
}

/**
 * Validate one op's payload against its specification.
 * @param {string} op
 * @param {unknown} payload
 * @returns {object} a fresh object holding only validated fields
 * @throws {HostError} invalid_request
 */
export function parsePayload(op, payload) {
  const spec = PAYLOAD_SPECS[op];
  if (spec === undefined) throw new HostError('unknown_op', { op });
  if (!isPlainObject(payload)) throw new HostError('invalid_request', { field: 'payload' });
  const out = {};
  for (const key of Object.keys(payload)) {
    const lower = key.toLowerCase();
    if (DENIED.has(lower)) throw new HostError('invalid_request', { field: key, denied: true });
    const field = spec[key];
    if (field === undefined) throw new HostError('invalid_request', { field: key, unexpected: true });
    const value = payload[key];
    if (field.type === 'string') {
      if (typeof value !== 'string') throw new HostError('invalid_request', { field: key, type: 'string' });
      if (value.length > field.maxLength) throw new HostError('invalid_request', { field: key, tooLong: true });
      if (field.nonEmpty && (value.trim() !== value || !isNonEmptyString(value) || /[\u0000-\u001f\u007f]/.test(value))) {
        throw new HostError('invalid_request', { field: key });
      }
      out[key] = value;
    } else if (field.type === 'integer') {
      if (!Number.isSafeInteger(value) || value < field.min || value > field.max) {
        throw new HostError('invalid_request', { field: key, type: 'integer' });
      }
      out[key] = value;
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean' || (Object.hasOwn(field, 'literal') && value !== field.literal)) {
        throw new HostError('invalid_request', { field: key, type: 'boolean' });
      }
      out[key] = value;
    } else {
      throw new HostError('internal', { field: key, type: field.type });
    }
  }
  for (const key of Object.keys(spec)) {
    if (spec[key].required === true && !Object.prototype.hasOwnProperty.call(out, key)) {
      throw new HostError('invalid_request', { field: key, missing: true });
    }
  }
  return out;
}
