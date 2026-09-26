import { describe, expect, it } from 'vitest'
import { buildRAGPrompt, finalAnswer } from './rag'

describe('browser RAG grounding', () => {
  it('uses a bounded set of near-top documents and preserves their IDs', () => {
    const { messages, sources } = buildRAGPrompt('What changed?', [
      { id: 'DOC-A', score: 10, contents: 'A'.repeat(2_000) },
      { id: 'DOC-B', score: 8, contents: 'Relevant finding.' },
      { id: 'DOC-C', score: 2, contents: 'Distant match.' },
    ])

    expect(sources.map(({ id }) => id)).toEqual(['DOC-A', 'DOC-B'])
    expect(sources[0].excerpt).toHaveLength(1_200)
    expect(messages[1].content).toContain('[1] NFCorpus ID: DOC-A')
    expect(messages[1].content).not.toContain('DOC-C')
  })

  it('accepts a cited answer and removes any reasoning block', () => {
    expect(finalAnswer('<think>private scratch work</think>Exercise was associated with lower risk [1].', 1))
      .toBe('Exercise was associated with lower risk [1].')
  })

  it('withholds answers with an uncited sentence or a nonexistent source', () => {
    const withheld = 'The model did not return a cited answer. Review the retrieved sources below.'
    expect(finalAnswer('Exercise was associated with lower risk [1]. Smoking was higher.', 1))
      .toBe(withheld)
    expect(finalAnswer('Exercise was associated with lower risk [2].', 1))
      .toBe(withheld)
    expect(finalAnswer('Exercise was associated with lower risk.', 1))
      .toBe(withheld)
  })

  it('does not expose an unfinished reasoning block', () => {
    expect(finalAnswer('<think>private scratch work', 1))
      .toBe('The model returned no final answer. Review the retrieved sources below.')
  })
})
