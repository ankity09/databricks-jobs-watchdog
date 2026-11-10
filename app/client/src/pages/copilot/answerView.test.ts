import type { GenieStatementResponse } from '@databricks/appkit-ui/react';
import { describe, expect, it } from 'vitest';
import { chooseAnswerView, csvFileName, statusColumnIndexes, toCsv } from './answerView';

function statement(columns: [string, string][], rows: (string | null)[][]): GenieStatementResponse {
  return {
    manifest: { schema: { columns: columns.map(([name, type_name]) => ({ name, type_name })) } },
    result: { data_array: rows },
  };
}

function perDay(count: number): GenieStatementResponse {
  return statement(
    [
      ['day', 'DATE'],
      ['failed_jobs', 'BIGINT'],
    ],
    Array.from({ length: count }, (_, i) => [`2026-10-${String((i % 28) + 1).padStart(2, '0')}`, String(i + 1)])
  );
}

function parts(count: number, value: (i: number) => string): GenieStatementResponse {
  return statement(
    [
      ['team', 'STRING'],
      ['jobs', 'BIGINT'],
    ],
    Array.from({ length: count }, (_, i) => [`team-${i}`, value(i)])
  );
}

describe('chooseAnswerView', () => {
  it('a per-day count is a chart with day on x', () => {
    const view = chooseAnswerView(perDay(12));
    expect(view.kind).toBe('chart');
    if (view.kind !== 'chart') return;
    expect(view.xKey).toBe('day');
    expect(view.yKey).toBe('failed_jobs');
    expect(view.choices.length).toBeGreaterThan(0);
  });

  it('a text axis offers no line or area', () => {
    const view = chooseAnswerView(parts(9, (i) => String(i + 1)));
    expect(view.kind).toBe('chart');
    if (view.kind !== 'chart') return;
    expect(view.chartType).toBe('bar');
    expect(view.choices).toContain('bar');
    expect(view.choices).not.toContain('line');
    expect(view.choices).not.toContain('area');
    const many = chooseAnswerView(parts(40, (i) => String(i + 1)));
    if (many.kind !== 'chart') throw new Error('expected a chart');
    expect(many.chartType).toBe('bar');
    expect(many.choices).toEqual(['bar']);
  });

  it('one number is a number', () => {
    const view = chooseAnswerView(statement([['failed_jobs', 'BIGINT']], [['42']]));
    expect(view).toEqual({ kind: 'number', label: 'failed_jobs', value: '42' });
  });

  it('a pie needs parts of a whole', () => {
    const negative = chooseAnswerView(parts(4, (i) => (i === 1 ? '-3' : '5')));
    const many = chooseAnswerView(parts(9, () => '5'));
    for (const view of [negative, many]) {
      expect(view.kind).toBe('chart');
      if (view.kind !== 'chart') continue;
      expect(view.chartType).toBe('bar');
      expect(view.choices).not.toContain('pie');
      expect(view.choices).not.toContain('donut');
    }
    const whole = chooseAnswerView(parts(4, () => '5'));
    expect(whole.kind === 'chart' && whole.chartType).toBe('pie');
    expect(whole.kind === 'chart' && whole.choices).toContain('donut');
  });

  it('60 categories open as a table', () => {
    const view = chooseAnswerView(parts(60, (i) => String(i)));
    expect(view.kind).toBe('table');
    if (view.kind !== 'table') return;
    expect(view.choices).toContain('bar');
  });

  it('zero rows, one text column and nulls in a numeric column never throw', () => {
    expect(chooseAnswerView(null)).toEqual({ kind: 'table', choices: [] });
    expect(chooseAnswerView(statement([['day', 'DATE']], []))).toEqual({ kind: 'table', choices: [] });
    expect(
      chooseAnswerView(statement([['job_name', 'STRING']], [['orders_ingest'], ['daily_revenue_report']]))
    ).toEqual({
      kind: 'table',
      choices: [],
    });
    expect(() =>
      chooseAnswerView(
        statement(
          [
            ['team', 'STRING'],
            ['jobs', 'BIGINT'],
          ],
          [
            ['a', null],
            ['b', null],
          ]
        )
      )
    ).not.toThrow();
    expect(chooseAnswerView(statement([['jobs', 'BIGINT']], [[null]])).kind).toBe('table');
  });

  it('5,000 rows choose a view', () => {
    expect(chooseAnswerView(perDay(5000)).kind).toBe('chart');
    expect(chooseAnswerView(parts(5000, (i) => String(i))).kind).toBe('table');
  });
});

describe('toCsv', () => {
  it('CSV quotes commas, quotes and new lines', () => {
    const csv = toCsv(
      ['name', 'note'],
      [
        ['a,b', 'say "hi"'],
        ['line\nbreak', null],
      ]
    );
    expect(csv).toBe('name,note\r\n"a,b","say ""hi"""\r\n"line\nbreak",');
  });

  it('CSV guards formulas but keeps negative numbers', () => {
    const csv = toCsv(['v'], [['=SUM(A1)'], ['+1'], ['@x'], ['\tx'], ['-cmd'], ['-12.5'], ['plain']]);
    expect(csv.split('\r\n')).toEqual(['v', "'=SUM(A1)", "'+1", "'@x", "'\tx", "'-cmd", '-12.5', 'plain']);
  });
});

describe('csvFileName', () => {
  it('csvFileName makes a slug', () => {
    expect(csvFileName('Jobs with a failed finding per day')).toBe('jobs-with-a-failed-finding-per-day.csv');
    expect(csvFileName('  Top 10: teams (by jobs)! ')).toBe('top-10-teams-by-jobs.csv');
    expect(csvFileName(null)).toBe('copilot-answer.csv');
    expect(csvFileName('???')).toBe('copilot-answer.csv');
  });
});

describe('statusColumnIndexes', () => {
  it('status columns need a status name and status values', () => {
    const rows = [
      ['orders_ingest', 'HEALTHY', 'red'],
      ['daily_revenue_report', 'FAILED', 'blue'],
      ['nightly_sync', null, 'blue'],
    ];
    expect([...statusColumnIndexes(['job_name', 'status', 'color_status'], rows)]).toEqual([1]);
    expect(statusColumnIndexes(['job_name', 'state'], [['a', 'HEALTHY']]).size).toBe(0);
  });

  it('mixed case still counts', () => {
    expect([...statusColumnIndexes(['Run_STATUS'], [['Warning'], ['unknown'], ['failed']])]).toEqual([0]);
  });

  it('SKIPPED makes it a plain column', () => {
    expect(statusColumnIndexes(['status'], [['HEALTHY'], ['SKIPPED']]).size).toBe(0);
  });
});
