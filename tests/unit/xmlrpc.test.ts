import { describe, expect, it } from 'vitest';
import {
  buildMethodCall,
  decodeXmlValue,
  encodeXmlValue,
  parseMethodResponse,
  XmlRpcFaultError,
} from '../../src/integrations/odoo/xmlrpc.js';

describe('XML-RPC codec', () => {
  it('encodes the different value types', () => {
    expect(encodeXmlValue('abc')).toContain('<string>abc</string>');
    expect(encodeXmlValue(42)).toContain('<int>42</int>');
    expect(encodeXmlValue(4.5)).toContain('<double>4.5</double>');
    expect(encodeXmlValue(true)).toContain('<boolean>1</boolean>');
    expect(encodeXmlValue(['a', 'b'])).toContain('<array>');
    expect(encodeXmlValue({ id: 1, name: 'x' })).toContain('<struct>');
    expect(encodeXmlValue({ id: 1, name: 'x' })).toContain('<name>name</name>');
  });

  it('escapes XML entities', () => {
    expect(encodeXmlValue('a & b < c')).toContain('a &amp; b &lt; c');
  });

  it('builds a method call', () => {
    const xml = buildMethodCall('call', ['db', 1, 'pass']);
    expect(xml).toContain('<methodName>call</methodName>');
    expect(xml).toContain('<string>db</string>');
    expect(xml).toContain('<int>1</int>');
  });

  it('decodes a method response', () => {
    const xml = `<?xml version="1.0"?>
      <methodResponse>
        <params>
          <param>
            <value><int>42</int></value>
          </param>
        </params>
      </methodResponse>`;
    expect(parseMethodResponse(xml)).toBe(42);
  });

  it('decodes a struct response', () => {
    const xml = `<?xml version="1.0"?>
      <methodResponse>
        <params>
          <param>
            <value>
              <struct>
                <member><name>id</name><value><int>7</int></value></member>
                <member><name>name</name><value><string>demo</string></value></member>
                <member><name>active</name><value><boolean>1</boolean></value></member>
                <member><name>lines</name><value><array><data><value><int>1</int></value><value><int>2</int></value></data></array></value></member>
              </struct>
            </value>
          </param>
        </params>
      </methodResponse>`;
    expect(parseMethodResponse(xml)).toEqual({
      id: 7,
      name: 'demo',
      active: true,
      lines: [1, 2],
    });
  });

  it('throws a fault error', () => {
    const xml = `<?xml version="1.0"?>
      <methodResponse>
        <fault>
          <value>
            <struct>
              <member><name>faultCode</name><value><int>3</int></value></member>
              <member><name>faultString</name><value><string>Invalid field</string></value></member>
            </struct>
          </value>
        </fault>
      </methodResponse>`;
    expect(() => parseMethodResponse(xml)).toThrow(XmlRpcFaultError);
  });

  it('decodes a single value', () => {
    expect(decodeXmlValue({ string: 'hello' })).toBe('hello');
    expect(decodeXmlValue({ int: 3 })).toBe(3);
    expect(decodeXmlValue({ double: 3.5 })).toBe(3.5);
    expect(decodeXmlValue({ boolean: '1' })).toBe(true);
  });
});
