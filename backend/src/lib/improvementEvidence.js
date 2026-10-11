import { createHash } from 'node:crypto';
import { normalizeOutputFormat } from './constants.js';
import { ValidationError } from './validation.js';

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function workflowSnapshot(workflow, steps) {
  const levels = new Map();
  const ordered = [...steps].sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const step of ordered) {
    if (step.boundSourceStepId != null) {
      throw new ValidationError([
        { field: 'workflow', message: 'Self-improvement does not support bound routing yet.' },
      ]);
    }
    if (!levels.has(step.depth)) {
      levels.set(step.depth, {
        depth: step.depth,
        multiOutput: step.multiOutput,
        consumesAll: step.consumesAll ?? false,
        outputFormat: normalizeOutputFormat(step.outputFormat),
        steps: [],
      });
    }
    levels.get(step.depth).steps.push({ name: step.name || '', content: step.content });
  }
  return { name: workflow.name, description: workflow.description || '', levels: [...levels.values()] };
}

export function assertApprovedWorkflow(expected, workflow, steps) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new ValidationError([{ field: 'expectedWorkflowDigest', message: 'Expected a SHA-256 workflow digest.' }]);
  }
  const actual = createHash('sha256')
    .update(canonicalJson(workflowSnapshot(workflow, steps)))
    .digest('hex');
  if (actual !== expected) {
    throw new ValidationError([
      { field: 'expectedWorkflowDigest', message: 'Workflow changed since approval. Review and approve it again.' },
    ]);
  }
}

export function boundedEvidence(value, depth = 0) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value.length > 1000 ? `${value.slice(0, 1000)} [truncated]` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return '[nested evidence omitted]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => boundedEvidence(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 20)
      .map(([key, item]) => [key, boundedEvidence(item, depth + 1)])
  );
}
