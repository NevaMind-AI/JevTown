import {
  FORMAT_BREAK_THRESHOLD,
  GateDocument,
  KNOWLEDGE_STALE_THRESHOLD,
  gateFromAnswers,
  jevGateRequest,
} from './gateJev';
import { SystemOneAnswers } from './model/client';

const DOCUMENTS: GateDocument[] = [
  {
    entityId: 'p:2',
    tier: 'actor',
    reason: 'She was surprised.',
    state: 'state: shaken\n\nBreathing hard.\n\nShe means to sit down.',
  },
  {
    entityId: 'e:1',
    tier: 'prop',
    reason: 'Alice forced it.',
    state: 'state: open\n\nSplintered at the latch.',
  },
];

const ARGS = {
  persona: 'You are the quiet overseer of this valley.',
  commonKnowledge: 'state: quiet\n\nThe mill has run all week.',
  documents: DOCUMENTS,
};

/** A `noul` answer as the API returns one: a probability, with no confidence of its own. */
const said = (noul: number) => ({ type: 'noul' as const, noul });

describe('jevGateRequest', () => {
  test('asks one question per document, plus the common-knowledge one', () => {
    const request = jevGateRequest(ARGS);

    expect(Object.keys(request.questions)).toEqual(['format_1', 'format_2', 'knowledge']);
    expect(request.documents).toEqual({ format_1: 'p:2', format_2: 'e:1' });
  });

  test('never puts an entity id in front of the model', () => {
    const request = jevGateRequest(ARGS);

    // The id is the mapping, not the prompt. `decideJev.ts` holds the same line for the same
    // reason: `p:2` means nothing, so asking a model to reason about it is asking it to reason
    // about noise.
    const sent = JSON.stringify({ state: request.state, questions: request.questions });
    expect(sent).not.toContain('p:2');
    expect(sent).not.toContain('e:1');
  });

  test('names the variant each document is judged against, in the question itself', () => {
    const { questions } = jevGateRequest(ARGS);
    const first = questions.format_1 as { instructions: string };
    const second = questions.format_2 as { instructions: string };

    expect(first.instructions).toContain('`document_1`');
    expect(first.instructions).toContain('an entity that acts');
    expect(second.instructions).toContain('`document_2`');
    expect(second.instructions).toContain('an entity that does not act');
    // The whole point of one question per document: neither is told to judge against both.
    expect(first.instructions).not.toContain('does not act');
  });

  test('carries the same evidence the chat gate batches: kind, reason, document', () => {
    const { state } = jevGateRequest(ARGS);

    expect(state.document_1).toContain('Written by an entity that acts.');
    expect(state.document_1).toContain('Reason for the write: She was surprised.');
    expect(state.document_1).toContain('Breathing hard.');
    expect(state.how_documents_must_be_written).toContain('Every entity writes its state');
    expect(state.what_common_knowledge_is_for).toContain('Common knowledge is one document');
    expect(state.what_everyone_here_knows).toContain('The mill has run all week.');
    expect(state.who_you_are).toBe(ARGS.persona);
  });

  test('states an empty common knowledge rather than omitting the field', () => {
    for (const commonKnowledge of [undefined, '', '   ']) {
      const { state } = jevGateRequest({ ...ARGS, commonKnowledge });
      // A missing field and a field saying "nothing yet" are different questions. The gate is
      // being asked whether something is missing from it, so it has to be shown as empty.
      expect(state.what_everyone_here_knows).toBe('(nothing has been written there yet)');
    }
  });

  test('two writes to the same entity stay two questions', () => {
    const { questions, documents } = jevGateRequest({
      ...ARGS,
      documents: [DOCUMENTS[0], { ...DOCUMENTS[0], reason: 'She sat down.' }],
    });

    expect(Object.keys(questions)).toEqual(['format_1', 'format_2', 'knowledge']);
    expect(documents).toEqual({ format_1: 'p:2', format_2: 'p:2' });
  });
});

describe('gateFromAnswers', () => {
  const request = jevGateRequest(ARGS);

  test('names which documents broke, which the chat gate cannot say', () => {
    const reading = gateFromAnswers(
      { format_1: said(0.82), format_2: said(0.13), knowledge: said(0.1) },
      request,
    );

    expect(reading.intervene).toBe(true);
    expect(reading.flagged).toEqual(['p:2']);
    expect(reading.knowledgeStale).toBe(false);
    expect(reading.why).toBe('documents p:2 0.82 · knowledge 0.10');
  });

  test('common knowledge fires on its own, with no document flagged', () => {
    const reading = gateFromAnswers(
      { format_1: said(0.04), format_2: said(0.13), knowledge: said(0.91) },
      request,
    );

    expect(reading.intervene).toBe(true);
    expect(reading.flagged).toEqual([]);
    expect(reading.knowledgeStale).toBe(true);
    // The two questions no longer share one boolean, so the transcript records both numbers even
    // when only one of them fired.
    expect(reading.why).toBe('documents clear (highest e:1 0.13) · knowledge 0.91');
  });

  test('reports the highest number when nothing cleared, for tuning', () => {
    const reading = gateFromAnswers(
      { format_1: said(0.47), format_2: said(0.02), knowledge: said(0.03) },
      request,
    );

    expect(reading.intervene).toBe(false);
    expect(reading.why).toBe('documents clear (highest p:2 0.47) · knowledge 0.03');
  });

  test('the thresholds are inclusive, and each gates only its own question', () => {
    const onFormat = gateFromAnswers(
      {
        format_1: said(FORMAT_BREAK_THRESHOLD),
        format_2: said(0),
        knowledge: said(KNOWLEDGE_STALE_THRESHOLD - 0.01),
      },
      request,
    );
    expect(onFormat.flagged).toEqual(['p:2']);
    expect(onFormat.knowledgeStale).toBe(false);

    const onKnowledge = gateFromAnswers(
      {
        format_1: said(FORMAT_BREAK_THRESHOLD - 0.01),
        format_2: said(0),
        knowledge: said(KNOWLEDGE_STALE_THRESHOLD),
      },
      request,
    );
    expect(onKnowledge.flagged).toEqual([]);
    expect(onKnowledge.knowledgeStale).toBe(true);
  });

  test('deduplicates an entity that broke the rule in two of its writes', () => {
    const twice = jevGateRequest({ ...ARGS, documents: [DOCUMENTS[0], DOCUMENTS[0]] });
    const reading = gateFromAnswers(
      { format_1: said(0.9), format_2: said(0.8), knowledge: said(0) },
      twice,
    );

    // Two questions, one entity: stage two is shown one document and `loadEntityStates` reads it
    // once. The `why` still carries both numbers, because they were two separate judgements.
    expect(reading.flagged).toEqual(['p:2']);
    expect(reading.why).toBe('documents p:2 0.90, p:2 0.80 · knowledge 0.00');
  });

  test('an unreadable answer is a problem, not a flag', () => {
    const reading = gateFromAnswers(
      {
        format_1: { type: 'choice', choice: 'yes' },
        format_2: said(0.05),
        knowledge: said(0.05),
      } as unknown as SystemOneAnswers,
      request,
    );

    expect(reading.intervene).toBe(false);
    expect(reading.flagged).toEqual([]);
    expect(reading.problems.join(' ')).toContain('no readable answer for format_1 (p:2)');
  });

  test('a missing knowledge answer is flagged and reads as "not stale"', () => {
    const reading = gateFromAnswers({ format_1: said(0.1), format_2: said(0.1) }, request);

    expect(reading.knowledgeStale).toBe(false);
    expect(reading.why).toContain('knowledge ?');
    expect(reading.problems).toContain('no readable answer for knowledge');
  });

  test('never throws, and an unreadable gate does not intervene — the safe direction', () => {
    for (const answers of [undefined, null, 'no', 3, {}]) {
      const value = answers as unknown as SystemOneAnswers;
      expect(() => gateFromAnswers(value, request)).not.toThrow();
      expect(gateFromAnswers(value, request).intervene).toBe(false);
      expect(gateFromAnswers(value, request).flagged).toEqual([]);
    }
  });
});
