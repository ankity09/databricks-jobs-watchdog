import { describe, expect, it } from 'vitest';
import { statementMeta, toGenieStatement } from './copilot-api';

describe('toGenieStatement', () => {
  it('keeps column types and turns cells into strings', () => {
    const data = {
      manifest: {
        schema: {
          columns: [{ name: 'team', type_name: 'STRING' }, { name: 'jobs', type_name: 'BIGINT' }, { name: 'ok' }],
        },
        total_row_count: 7,
        truncated: true,
      },
      result: {
        data_array: [
          ['a', 3, true],
          ['b', null, false],
        ],
      },
    };
    const statement = toGenieStatement(data);
    expect(statement.manifest.schema.columns).toEqual([
      { name: 'team', type_name: 'STRING' },
      { name: 'jobs', type_name: 'BIGINT' },
      { name: 'ok', type_name: 'STRING' },
    ]);
    expect(statement.result.data_array).toEqual([
      ['a', '3', 'true'],
      ['b', null, 'false'],
    ]);
    expect(statementMeta(data)).toEqual({ rowCount: 7, truncated: true });
  });

  it('counts the rows when the statement has no total', () => {
    expect(statementMeta({ result: { data_array: [['a'], ['b']] } })).toEqual({ rowCount: 2, truncated: false });
    expect(toGenieStatement({}).result.data_array).toEqual([]);
  });
});
