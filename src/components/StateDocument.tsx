/**
 * A prose state document, rendered as a single block of plain text (docs/05 §5.1).
 *
 * The document is written in three parts — a head state line and a paragraph or two of prose — but
 * it reads as one thing, so it is shown as one thing, in the same box the description gets.
 * Nothing is parsed out or reformatted: a malformed document should look malformed rather than
 * disappear.
 */
export function StateDocument({ state }: { state?: string }) {
  if (!state) {
    return (
      <p className="text-sm text-brown-200 italic">
        Nothing has happened to it yet — no state has been written.
      </p>
    );
  }
  const text = state.replace(/\r\n/g, '\n').trim();

  return (
    <div className="desc">
      <p className="leading-tight -m-4 bg-brown-700 text-base sm:text-sm whitespace-pre-line">
        {text}
      </p>
    </div>
  );
}
