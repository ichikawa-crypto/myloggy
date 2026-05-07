import assert from 'node:assert/strict';
import test from 'node:test';

import { looksDegenerateModelText } from './llm.js';

const degenerateCases: string[] = [
  'ドキュlang_label_lang_label_lang_label_lang_label_lang_label',
  'ドキュlang_label_label_label_label_label_label_label_label',
  'コーディング-管理-管理-管理-管理-管理-管理-管理-管理',
  'cannot be classification. cannot be classification. cannot be classification. cannot be classification.',
  'based-based-based-based-based-based',
  '_of_the_of_the_of_the_of_the_of_the',
  'Unknown Unknown Unknown Unknown Unknown Unknown Unknown Unknown',
  'foo | foo | foo | foo | foo',
];

const normalCases: string[] = [
  '英語学習のSEO記事を執筆中。',
  '判定できる情報が不足している。',
  'コード解析・ドキュメント閲覧',
  'PRレビューを進めている',
  'Cursorでmyloggyのコードを編集中',
];

test('looksDegenerateModelText returns true for degenerate / repetitive model output', () => {
  for (const line of degenerateCases) {
    assert.equal(
      looksDegenerateModelText(line),
      true,
      `expected degenerate: ${JSON.stringify(line)}`,
    );
  }
});

test('looksDegenerateModelText returns false for ordinary summaries', () => {
  for (const line of normalCases) {
    assert.equal(
      looksDegenerateModelText(line),
      false,
      `expected non-degenerate: ${JSON.stringify(line)}`,
    );
  }
});
