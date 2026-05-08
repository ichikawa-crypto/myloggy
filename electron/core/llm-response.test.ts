import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { normalizeCheckpointLlmOutput } from './llm-response.js';

const checkpointSchema = z.object({
  project_name: z.string().default('Unknown'),
  task_label: z.string().default('Unknown task'),
  state_summary: z.string().default('Insufficient metadata'),
  evidence: z.array(z.string()).default(['Insufficient metadata']),
  continuity: z.enum(['continue', 'switch', 'unclear']).default('unclear'),
  confidence: z.union([z.number(), z.string().transform(Number)]).pipe(z.number().min(0).max(1)).default(0.3),
  is_distracted: z.boolean().default(false),
});

test('normalizes valid JSON string responses without changing their meaning', () => {
  const parsed = checkpointSchema.parse(normalizeCheckpointLlmOutput(`
    \`\`\`json
    {
      "project_name": "myloggy",
      "task_label": "エラー調査",
      "state_summary": "LLMレスポンスの不正型を確認している。",
      "evidence": ["エラーログを確認した。", "正規化関数を見直した。"],
      "continuity": "continue",
      "confidence": 0.92,
      "is_distracted": false
    }
    \`\`\`
  `));

  assert.equal(parsed.project_name, 'myloggy');
  assert.equal(parsed.task_label, 'エラー調査');
  assert.deepEqual(parsed.evidence, ['エラーログを確認した。', '正規化関数を見直した。']);
  assert.equal(parsed.continuity, 'continue');
  assert.equal(parsed.confidence, 0.92);
  assert.equal(parsed.is_distracted, false);
});

test('normalizes structured object fields before the string schema parses them', () => {
  const parsed = checkpointSchema.parse(normalizeCheckpointLlmOutput({
    response: {
      projectName: { value: 'aidrivensales' },
      taskLabel: { text: 'PRレビュー' },
      stateSummary: {
        summary: '差分を確認している',
        description: '関連コメントも読んでいる',
      },
      evidence: [
        { text: 'PR画面を開いた' },
        { title: '差分を確認した' },
        { description: 'レビューコメントを確認した' },
      ],
      continuity: { value: 'switch' },
      confidence: { score: '0.67' },
      isDistracted: { value: 'false' },
    },
  }));

  assert.equal(parsed.project_name, 'aidrivensales');
  assert.equal(parsed.task_label, 'PRレビュー');
  assert.equal(parsed.state_summary, '差分を確認している / 関連コメントも読んでいる');
  assert.deepEqual(parsed.evidence, [
    'PR画面を開いた',
    '差分を確認した',
    'レビューコメントを確認した',
  ]);
  assert.equal(parsed.continuity, 'switch');
  assert.equal(parsed.confidence, 0.67);
  assert.equal(parsed.is_distracted, false);
});

test('enriches generic Japanese task_label using sheet name from evidence[0]', () => {
  const normalized = normalizeCheckpointLlmOutput({
    project_name: 'その他',
    task_label: 'スプレッドシート作業',
    state_summary: '集計中',
    evidence: ['シート名: 顧客管理_4月', 'URL: docs.google.com/spreadsheets/d/abc/edit', 'active_app=Google Chrome'],
    continuity: 'continue',
    confidence: 0.5,
    is_distracted: false,
  });
  const parsed = checkpointSchema.parse(normalized);
  assert.equal(parsed.task_label, '顧客管理_4月 スプレッドシート編集');
});

test('leaves task_label unchanged when generic label has no extractable subject in evidence', () => {
  const normalized = normalizeCheckpointLlmOutput({
    project_name: 'その他',
    task_label: 'スプレッドシート作業',
    state_summary: '作業中',
    evidence: ['Chrome foreground', 'no sheet metadata'],
    continuity: 'unclear',
    confidence: 0.4,
    is_distracted: false,
  });
  const parsed = checkpointSchema.parse(normalized);
  assert.equal(parsed.task_label, 'スプレッドシート作業');
});

test('normalizes the reproduced evidence object array that previously triggered five invalid_type errors', () => {
  const parsed = checkpointSchema.parse(normalizeCheckpointLlmOutput({
    response: JSON.stringify({
      project_name: 'myloggy',
      task_label: '再現確認',
      state_summary: 'structured evidence を処理している',
      evidence: [
        { text: '項目1' },
        { title: '項目2' },
        { description: '項目3' },
        { content: '項目4' },
        { value: '項目5' },
      ],
      continuity: 'continue',
      confidence: '0.51',
      is_distracted: false,
    }),
  }));

  assert.deepEqual(parsed.evidence, ['項目1', '項目2', '項目3', '項目4', '項目5']);
  assert.equal(parsed.confidence, 0.51);
  assert.equal(parsed.continuity, 'continue');
});
