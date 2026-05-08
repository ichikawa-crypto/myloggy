import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalizeProject } from '../../shared/localization.js';

test('canonicalizeProject maps aliases and exact canonical strings', () => {
  assert.equal(canonicalizeProject('タビケン'), 'タビケン留学');
  assert.equal(canonicalizeProject('Albona'), 'アルボナ');
  assert.equal(canonicalizeProject('アルボナ'), 'アルボナ');
  assert.equal(canonicalizeProject('イングリード'), 'イングリード');
});

test('canonicalizeProject absorbs parentheses and substring hints', () => {
  assert.equal(canonicalizeProject('タビケン留学（カウンセリング）'), 'タビケン留学');
  assert.equal(canonicalizeProject('TFレポート確認'), 'タビケン留学');
});

test('canonicalizeProject falls back to その他 when empty or unknown', () => {
  assert.equal(canonicalizeProject(''), 'その他');
  assert.equal(canonicalizeProject('   '), 'その他');
  assert.equal(canonicalizeProject(null), 'その他');
  assert.equal(canonicalizeProject(undefined), 'その他');
  assert.equal(canonicalizeProject('完全に別の名前XYZ123'), 'その他');
});
