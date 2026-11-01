/**
 * Minimal XML-RPC codec for the Odoo external API.
 *
 * Only the subset Odoo needs is implemented: string, int/i4, double, boolean,
 * date, base64, array and struct.
 */
import { XMLParser } from 'fast-xml-parser';

// `parseTagValue` is disabled so that a string that looks like a number
// (an order reference for instance) keeps its type.
const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
  parseAttributeValue: false,
});

export function encodeXmlValue(value: unknown): string {
  if (value === null || value === undefined) return '<value><string></string></value>';
  if (typeof value === 'string') {
    return `<value><string>${escapeXml(value)}</string></value>`;
  }
  if (typeof value === 'boolean') {
    return `<value><boolean>${value ? 1 : 0}</boolean></value>`;
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return `<value><int>${value}</int></value>`;
    return `<value><double>${value}</double></value>`;
  }
  if (value instanceof Date) {
    return `<value><dateTime.iso8601>${value.toISOString()}</dateTime.iso8601></value>`;
  }
  if (Buffer.isBuffer(value)) {
    return `<value><base64>${value.toString('base64')}</base64></value>`;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => `<value>${encodeXmlInner(item)}</value>`).join('');
    return `<value><array><data>${items}</data></array></value>`;
  }
  if (typeof value === 'object') {
    const members = Object.entries(value as Record<string, unknown>)
      .map(
        ([key, member]) =>
          `<member><name>${escapeXml(key)}</name><value>${encodeXmlInner(member)}</value></member>`,
      )
      .join('');
    return `<value><struct>${members}</struct></value>`;
  }
  return `<value><string>${escapeXml(String(value))}</string></value>`;
}

function encodeXmlInner(value: unknown): string {
  const encoded = encodeXmlValue(value);
  return encoded.replace(/^<value>|<\/value>$/g, '');
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildMethodCall(method: string, params: unknown[]): string {
  const encoded = params
    .map((param) => `<param>${encodeXmlValue(param)}</param>`)
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<methodCall>
  <methodName>${escapeXml(method)}</methodName>
  <params>${encoded}</params>
</methodCall>`;
}

export function decodeXmlValue(node: unknown): unknown {
  if (node === null || node === undefined) return null;
  if (typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((item) => decodeXmlValue(item));

  const keys = Object.keys(node as Record<string, unknown>);
  if (keys.length !== 1) return node;

  const key = keys[0]!;
  const inner = (node as Record<string, unknown>)[key];

  switch (key) {
    case 'string':
      return inner;
    case 'i4':
    case 'int':
      return Number(inner);
    case 'double':
      return Number(inner);
    case 'boolean':
      return inner === '1' || inner === 1 || inner === true || inner === 'true';
    case 'date':
    case 'dateTime.iso8601':
      return new Date(String(inner));
    case 'base64':
      return Buffer.from(String(inner), 'base64');
    case 'nil':
      return null;
    case 'array':
      return decodeArray(inner);
    case 'struct':
      return decodeStruct(inner);
    default:
      return inner;
  }
}

function decodeArray(inner: unknown): unknown[] {
  let data = (inner as Record<string, unknown> | undefined)?.data;
  if (data === undefined) return [];
  if (!Array.isArray(data) && data && typeof data === 'object' && 'value' in data) {
    // Several <value> children are grouped under a single "value" key.
    data = (data as Record<string, unknown>).value;
  }
  const entries = Array.isArray(data) ? data : [data];
  return entries.map((entry) => {
    const dict = entry as Record<string, unknown>;
    if (dict && 'value' in dict) return decodeXmlValue(dict.value);
    return decodeXmlValue(entry);
  });
}

function decodeStruct(inner: unknown): Record<string, unknown> {
  const members = (inner as Record<string, unknown> | undefined)?.member;
  const list = Array.isArray(members) ? members : members ? [members] : [];
  const result: Record<string, unknown> = {};
  for (const member of list) {
    const dict = member as Record<string, unknown>;
    const name = dict.name as string | undefined;
    if (!name) continue;
    result[name] = decodeXmlValue(dict.value);
  }
  return result;
}

/** Build an XML-RPC response for a successful call. */
export function buildMethodResponse(value: unknown): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<methodResponse>
  <params>
    <param>${encodeXmlValue(value)}</param>
  </params>
</methodResponse>`;
}

/** Parse an incoming XML-RPC method call (used by the test doubles). */
export function parseMethodCall(xml: string): { method: string; params: unknown[] } {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const call = parsed.methodCall as Record<string, unknown> | undefined;
  const method = String(call?.methodName ?? '');
  const params = call?.params as Record<string, unknown> | undefined;
  const list = Array.isArray(params?.param)
    ? (params?.param as unknown[])
    : params?.param
      ? [params.param]
      : [];
  return {
    method,
    params: list.map((param) =>
      decodeXmlValue((param as Record<string, unknown> | undefined)?.value),
    ),
  };
}

export interface XmlRpcFault {
  faultCode: number;
  faultString: string;
}

export class XmlRpcFaultError extends Error {
  constructor(readonly fault: XmlRpcFault) {
    super(`${fault.faultString} (code ${fault.faultCode})`);
    this.name = 'XmlRpcFaultError';
  }
}

/** Parse an XML-RPC response, throwing on faults. */
export function parseMethodResponse(xml: string): unknown {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const response = parsed.methodResponse as Record<string, unknown> | undefined;

  const fault = (parsed.fault ?? response?.fault) as Record<string, unknown> | undefined;
  if (fault) {
    const struct = decodeXmlValue(fault.value) as Record<string, unknown>;
    throw new XmlRpcFaultError({
      faultCode: Number(struct.faultCode ?? 0),
      faultString: String(struct.faultString ?? 'Unknown XML-RPC fault'),
    });
  }

  const params = response?.params as Record<string, unknown> | undefined;
  const param = params?.param as Record<string, unknown> | undefined;
  return decodeXmlValue(param?.value);
}
