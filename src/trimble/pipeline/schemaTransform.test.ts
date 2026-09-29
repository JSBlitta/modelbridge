import { describe, it, expect } from 'vitest';
import { schemaTransformTable, generateSchema } from './schemaTransform.js';

describe('schemaTransformTable', () => {
  it('coerces integer and number types', () => {
    const rows = [{ GUID: 'e1', Count: '42', Length: '3,14' }];
    const schema = [
      { name: 'GUID', type: 'string' },
      { name: 'Count', type: 'integer' },
      { name: 'Length', type: 'number' },
    ];

    const result = schemaTransformTable(rows, schema, 'ignoreMissing');

    expect(result[0]).toEqual({ GUID: 'e1', Count: 42, Length: 3.14 });
  });

  it('coerces boolean and string types', () => {
    const rows = [{ GUID: 'e1', Active: 'true', Name: 123 }];
    const schema = [
      { name: 'GUID', type: 'string' },
      { name: 'Active', type: 'boolean' },
      { name: 'Name', type: 'string' },
    ];

    const result = schemaTransformTable(rows, schema, 'ignoreMissing');

    expect(result[0]).toEqual({ GUID: 'e1', Active: true, Name: '123' });
  });

  it('fills missing columns with null', () => {
    const rows = [{ GUID: 'e1' }];
    const schema = [
      { name: 'GUID', type: 'string' },
      { name: 'Missing', type: 'string' },
    ];

    const result = schemaTransformTable(rows, schema, 'ignoreMissing');

    expect(result[0]).toEqual({ GUID: 'e1', Missing: null });
  });

  it('ignores extra columns in strict mode', () => {
    const rows = [{ GUID: 'e1', Extra: 'ignored' }];
    const schema = [{ name: 'GUID', type: 'string' }];

    const result = schemaTransformTable(rows, schema, 'strict');

    expect(result[0]).toEqual({ GUID: 'e1' });
  });
});

describe('generateSchema', () => {
  it('adds GUID column and deduplicates properties', () => {
    const defs = [
      { prop_name: 'A', prop_type: 'string' },
      { prop_name: 'B', prop_type: 'number' },
      { prop_name: 'A', prop_type: 'string' },
    ];

    const schema = generateSchema(defs);

    expect(schema).toEqual([
      { name: 'GUID', type: 'string' },
      { name: 'A', type: 'string' },
      { name: 'B', type: 'number' },
    ]);
  });
});
