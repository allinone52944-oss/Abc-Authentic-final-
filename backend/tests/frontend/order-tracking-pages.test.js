// Audit #43 — two tracking pages, information split. Status had the
// timeline + support messages + polling but no chat/file upload;
// detail had chat + file upload + stepper but no timeline/messages,
// and the delivery-file gating differed. Both pages now carry the
// same information: chat + upload on status, timeline + messages on
// detail, and one delivery-file rule on both.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('order-status.html — chat + upload + unified delivery gating (audit #43)', () => {
  const html = read('frontend/order-status.html');

  test('chat lives on this page (same /chat endpoint as detail)', () => {
    expect(html).toContain('id="chatBox"');
    expect(html).toContain('id="chatIn"');
    expect(html).toContain('function loadChat()');
    expect(html).toContain("'/orders/' + oid + '/chat'");
    expect(html).toContain('function sendChat()');
    expect(html).toContain('loadChat();');
  });

  test('file upload lives on this page (10 MB check, same /documents endpoint)', () => {
    expect(html).toContain('id="extraDocInp"');
    expect(html).toContain('function triggerExtraDoc()');
    expect(html).toContain('function uploadExtraDoc(files)');
    expect(html).toContain('10 * 1024 * 1024');
    expect(html).toContain("'/api/orders/' + oid + '/documents'");
  });

  test('delivery box uses the same rule as detail (refunded-after-delivery keeps its files)', () => {
    expect(html).toContain("o.delivered_before_refund === true");
    expect(html).toContain("st === 'refunded' && o.delivered_before_refund === true");
  });

  test('the doc-warning no longer sends users to the detail page for files', () => {
    const box = html.slice(html.indexOf('id="docWarningBox"'), html.indexOf('id="docWarningBox"') + 600);
    expect(box).not.toContain('অর্ডার ডিটেইলস ও চ্যাট');
    expect(box).toContain('ফাইল যোগ করুন');
  });

  test('timeline + support messages + stepper still here (no regression)', () => {
    expect(html).toContain('id="timeline"');
    expect(html).toContain('loadTimelineHistory()');
    expect(html).toContain('loadSupportMsgs()');
    expect(html).toContain('id="pipelineTrack"');
  });
});

describe('order-detail.html — timeline + support messages (audit #43)', () => {
  const html = read('frontend/order-detail.html');

  test('the real timeline lives here (same /history endpoint as status)', () => {
    expect(html).toContain('id="timeline"');
    expect(html).toContain('function loadTimelineHistory(o)');
    expect(html).toContain("'/orders/' + oid + '/history'");
    expect(html).toContain('function renderTimeline(history, o)');
    expect(html).toContain('আবেদন ও পেমেন্ট গৃহীত');
  });

  test('support messages live here (same /messages endpoint as status)', () => {
    expect(html).toContain('id="supMsgs"');
    expect(html).toContain('function loadSupportMsgs()');
    expect(html).toContain("'/orders/' + oid + '/messages'");
    expect(html).toContain('সাপোর্ট নোটিশ');
  });

  test('both are loaded in init (once per visit — no new 5s poll here)', () => {
    expect(html).toContain('loadTimelineHistory(o);');
    expect(html).toContain('loadSupportMsgs();');
    expect(html).not.toContain('setInterval');
  });

  test('chat + upload + stepper + live-tracker link still here (no regression)', () => {
    expect(html).toContain('id="chatBox"');
    expect(html).toContain('function uploadExtraDoc(files)');
    expect(html).toContain('detail-stepper');
    expect(html).toContain('লাইভ ট্র্যাকার দেখুন');
    expect(html).toContain("'/order-status.html?id='");
  });
});

describe('order tracking — customer cancel, new/pending only (audit #48)', () => {
  const statusHtml = read('frontend/order-status.html');
  const detailHtml = read('frontend/order-detail.html');

  test('both pages offer cancel, gated to new/pending, via POST /orders/:id/cancel', () => {
    for (const html of [statusHtml, detailHtml]) {
      expect(html).toContain('function cancelOrder()');
      expect(html).toContain("'/orders/' + oid + '/cancel'");
      expect(html).toMatch(/\['new',\s*'pending'\]\.includes\(/);
      expect(html).toContain('CANNOT_CANCEL');
      expect(html).toContain('অর্ডার বাতিল করুন');
    }
    expect(statusHtml).toContain('id="cancelBtn"');
  });

  test('the cancel confirm names the auto-refund', () => {
    expect(statusHtml).toContain('বাতিল করলে ফি স্বয়ংক্রিয়ভাবে ফেরত যাবে');
    expect(detailHtml).toContain('বাতিল করলে ফি স্বয়ংক্রিয়ভাবে ফেরত যাবে');
  });

  test('after a cancel the user sees the real refund split (status hero box / detail banner)', () => {
    expect(statusHtml).toContain('await fetchAndRender();');
    expect(detailHtml).toContain('_cancelMsg');
    expect(detailHtml).toContain('ওই সেবার ক্রেডিটে ফেরত দেওয়া হয়েছে');
  });
});

describe('order tracking — "এরপর কী" per step (audit #48)', () => {
  const statusHtml = read('frontend/order-status.html');
  const detailHtml = read('frontend/order-detail.html');

  test('a NEXT_STEP map exists on both pages (process steps, never a time promise)', () => {
    for (const html of [statusHtml, detailHtml]) {
      expect(html).toContain('const NEXT_STEP = {');
      expect(html).toContain('এডমিন আবেদনটি দেখে গৃহীত করবেন');
      expect(html).toContain('কাজ শেষ হলে ডেলিভারি ফাইল দেওয়া হবে');
      expect(html).toContain('আর কিছু করতে হবে না');
    }
    // no invented ETA anywhere on either page
    expect(statusHtml).not.toMatch(/আনুমানিক সময়|দিন লাগবে|ঘণ্টা লাগবে/);
    expect(detailHtml).not.toMatch(/আনুমানিক সময়|দিন লাগবে|ঘণ্টা লাগবে/);
  });

  test('the status page shows the next step under the stepper and on the current timeline item', () => {
    expect(statusHtml).toContain('id="nextStep"');
    expect(statusHtml).toContain("➡️ এরপর কী: ' + NEXT_STEP[st]");
    expect(statusHtml).toContain("next: isLast ? (NEXT_STEP[h.to_status] || null) : null");
    expect(statusHtml).toContain('এরপর কী: ');
  });

  test('the detail timeline carries the same next-step note', () => {
    expect(detailHtml).toContain("next: isLast ? (NEXT_STEP[h.to_status] || null) : null");
    expect(detailHtml).toContain('এরপর কী: ');
  });
});

describe('order-status.html — status words unified (audit #52)', () => {
  const status = read('frontend/order-status.html');
  const detail = read('frontend/order-detail.html');

  test('ST_TEXT uses the same short words as the list/detail STBN', () => {
    const stText = status.slice(status.indexOf('const ST_TEXT'), status.indexOf('const ST_EMOJI'));
    expect(stText).toContain("new: 'নতুন',");
    expect(stText).toContain("received: 'গৃহীত',");
    expect(stText).toContain("processing: 'প্রসেসিং',");
    expect(stText).toContain("delivered: 'ডেলিভার্ড',");
    expect(stText).not.toContain('নতুন আবেদন');
    expect(stText).not.toContain('গৃহীত ও যাচাই');
    expect(stText).not.toContain('প্রসেসিং চলমান');
    expect(stText).not.toContain('ডেলিভার্ড (ফাইল প্রস্তুত)');
    // the pipeline stepper's step-2 label uses the same word
    expect(status).toContain('<div class="step-text">গৃহীত</div>');
    expect(status).not.toContain('<div class="step-text">গৃহীত ও যাচাই</div>');
    // the detail page's STBN already used these words
    expect(detail).toContain("new:'নতুন'");
    expect(detail).toContain("received:'গৃহীত'");
  });
});
