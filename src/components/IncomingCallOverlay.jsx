import { createPortal } from 'react-dom';

/* The incoming call, full screen.
 *
 * The old alert was one line in the top bar, easy to miss with the CRM behind
 * another window or the agent looking at a ticket. This covers the whole page
 * with two big buttons, so a ringing phone looks like a ringing phone. Drawn
 * straight onto the body so no panel or drawer can sit on top of it.
 */
export default function IncomingCallOverlay({ callerName, callerNumber, test = false, soundOn = true, onAnswer, onDecline }) {
  const showNumber = callerNumber && callerNumber !== callerName;
  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" role="alertdialog" aria-label="Incoming call">
      <div className="w-full max-w-md rounded-3xl bg-white shadow-2xl p-7 text-center">
        <div className="mx-auto w-20 h-20 rounded-full bg-emerald-100 flex items-center justify-center text-4xl animate-bounce">{'\u{1F4DE}'}</div>
        <div className="mt-4 text-[11px] font-bold uppercase tracking-[0.2em] text-emerald-700">{test ? 'Test ring' : 'Incoming call'}</div>
        <div className="mt-1 text-2xl font-bold text-slate-900 break-words">{callerName || 'Unknown caller'}</div>
        {showNumber && <div className="mt-1 text-base font-mono text-slate-500">{callerNumber}</div>}
        {!soundOn && (
          <div className="mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
            This page is not allowed to make sound yet. Click anywhere on it once and it will ring out loud next time.
          </div>
        )}
        {test ? (
          <div className="mt-6">
            <p className="text-sm text-slate-600 mb-4">You should hear ringing, see this screen, and get a desktop alert. If one is missing, check the warnings next to the phone status.</p>
            <button onClick={onDecline} className="w-full py-4 rounded-2xl text-base font-bold bg-slate-900 text-white hover:bg-slate-800">Stop test</button>
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-2 gap-3">
            <button onClick={onDecline} className="py-4 rounded-2xl text-base font-bold bg-red-500 text-white hover:bg-red-600">Decline</button>
            <button onClick={onAnswer} autoFocus className="py-4 rounded-2xl text-base font-bold bg-emerald-500 text-white hover:bg-emerald-600">Answer</button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
