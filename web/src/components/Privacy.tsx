/**
 * What leaves this computer, said plainly wherever it happens (AI key, uploads, voice). Keep these in step with
 * the server: documents.ts (bills, workings, unmatched bank lines) and voice/engine.ts (requests + names).
 */
const TERMS = 'https://www.anthropic.com/legal/commercial-terms';
const PRIVACY = 'https://www.anthropic.com/legal/privacy';

export function AiDataNotice({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <p className="muted small">
        With AI on, PDFs and photos, sheets the app cannot read by itself, and bank lines no rule matches are sent to
        Anthropic&rsquo;s Claude to be read. <a href={PRIVACY} target="_blank" rel="noreferrer">Anthropic privacy policy</a>
      </p>
    );
  }
  return (
    <div className="muted small">
      <p><strong>What is sent to Anthropic when AI is on.</strong> Over the internet, to Anthropic&rsquo;s Claude API:</p>
      <ul>
        <li>PDFs and photos you upload (bills, invoices, statements), and Excel or CSV sheets the app cannot read by itself;</li>
        <li>bank statement lines that no rule or earlier choice matches (date, amount and narration);</li>
        <li>what you say or type to the voice assistant;</li>
        <li>with each of these, your company&rsquo;s name and GSTIN and the names of your ledgers, parties and items, so they can be matched.</li>
      </ul>
      <p>Excel and CSV statements, journals and registers the app recognises are read on this computer.
        Anthropic&rsquo;s <a href={TERMS} target="_blank" rel="noreferrer">commercial terms</a> say it does not train its models on API data by default;
        see its <a href={PRIVACY} target="_blank" rel="noreferrer">privacy policy</a>. These documents hold your customers&rsquo; and suppliers&rsquo;
        details, so make sure your own privacy notice to them allows this.</p>
    </div>
  );
}

/** Before the microphone is used: the browser, not Kannaku AI, turns speech into text, on its maker's servers. */
export function SpeechNotice({ wake }: { wake: boolean }) {
  return (
    <>
      <p><strong>Before you use the microphone</strong></p>
      <p className="small">Voice uses your browser&rsquo;s speech recognition: <strong>Chrome sends the microphone audio to Google, and Edge to Microsoft</strong>,
        to turn it into text, under their own privacy policies. Kannaku AI receives only the text, never the audio.
        That text is sent to Anthropic&rsquo;s Claude to understand it, and is kept in this company&rsquo;s voice log.</p>
      {wake && (
        <p className="small"><strong>&ldquo;Kannaku&rdquo; hands-free listening</strong> keeps the microphone on while this tab is showing,
          so everything said near the computer goes to Google or Microsoft to catch the word. It pauses while the tab is hidden (another tab
          is open, or the window is minimised). To post hands-free you say &ldquo;Kannaku, confirm&rdquo;; a bare &ldquo;yes&rdquo; nearby
          will not post anything. Turn it off at any time with the same tick box.</p>
      )}
    </>
  );
}
