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
