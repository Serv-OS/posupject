import DOMPurify from 'dompurify';

// Emails arrive as HTML. We render them inline, but they're untrusted, so every
// string is sanitized first: DOMPurify strips scripts + event handlers by
// default, and we additionally forbid iframes/forms/remote objects and <style>
// blocks (which would otherwise leak the email's CSS onto the whole app).
// Links are forced to open in a new tab.
let hooked = false;
function ensureHook() {
  if (hooked || typeof window === 'undefined') return;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  });
  hooked = true;
}

// Does this string look like HTML worth rendering (vs plain text)?
export function looksLikeHtml(s) {
  return typeof s === 'string'
    && /<\/?(?:div|table|td|tr|th|tbody|thead|p|span|a|img|br|hr|strong|em|b|i|u|h[1-6]|ul|ol|li|body|html|font|center|blockquote|style)\b[^>]*>/i.test(s);
}

// Sanitize email HTML for safe inline rendering.
export function sanitizeEmailHtml(html) {
  ensureHook();
  return DOMPurify.sanitize(html || '', {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'base', 'link'],
    FORBID_ATTR: ['srcset'],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ['target'],
  });
}

// Pick the HTML to render for an inbound email activity, if any: the captured
// html from ingest, else the body when it is itself HTML. Returns null for
// plain-text emails (which render as text as before).
export function emailHtmlFor(activity) {
  const md = activity?.channel_metadata || {};
  if (md.html && typeof md.html === 'string') return md.html;
  if (looksLikeHtml(activity?.body)) return activity.body;
  return null;
}
