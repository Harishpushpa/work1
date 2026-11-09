import fs from 'fs';
import * as XLSX from 'xlsx';
import type { RagTestQuestion } from './testing.types';

const QUESTION_KEYS = ['question', 'Question', 'QUESTION'];
const ID_KEYS = ['Test ID', 'test id', 'test_id', 'TestID', 'ID', 'id'];
const CATEGORY_KEYS = [
  'Test Category',
  'test category',
  'category',
  'Category',
];
const ANSWER_KEYS = [
  'Actual Answer',
  'actual answer',
  'actualAnswer',
  'Expected Answer',
  'expected answer',
  'expectedAnswer',
  'Answer',
  'answer',
  '__EMPTY',
];

function pick(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (row[key] != null && String(row[key]).trim()) {
      return String(row[key]).trim();
    }
  }
  // Fall back: first empty-header column (__EMPTY, __EMPTY_1, …)
  for (const [k, v] of Object.entries(row)) {
    if (/^__EMPTY/.test(k) && v != null && String(v).trim()) {
      return String(v).trim();
    }
  }
  return '';
}

/**
 * Parse RAG test questions from an .xlsx / .xls / .csv workbook.
 * Expected columns: Test ID, Test Category, Question, (answer — often headerless).
 */
export function parseQuestionsWorkbook(
  filePath: string,
  opts?: { limit?: number }
): RagTestQuestion[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Questions file not found: ${filePath}`);
  }

  const wb = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    throw new Error('Questions workbook has no sheets');
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    wb.Sheets[sheetName],
    { defval: '' }
  );

  const questions: RagTestQuestion[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const question = pick(row, QUESTION_KEYS);
    if (!question) continue;

    const testId = pick(row, ID_KEYS) || `Q${String(questions.length + 1).padStart(2, '0')}`;
    const category = pick(row, CATEGORY_KEYS);
    const actualAnswer = pick(row, ANSWER_KEYS);

    questions.push({ testId, category, question, actualAnswer });

    if (opts?.limit && questions.length >= opts.limit) break;
  }

  if (questions.length === 0) {
    throw new Error('No questions found in workbook (need a Question column)');
  }

  return questions;
}
