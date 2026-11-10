// Admin: wipe service history, orders and stored files (server enforces password, backup, no active orders).
window.admResetHistory = async function () {
    const t = prompt('নিশ্চিত হলে লিখুন: সব মুছুন');
    if (t == null) return;
    const pw = prompt('আপনার অ্যাডমিন পাসওয়ার্ড দিন');
    if (!pw) return;
    try {
      const r = await ABC.api('/admin/reset-history', { method: 'POST', body: { confirm_text: t, admin_password: pw } });
      const d = await r.json().catch(() => ({}));
      const msg = { CONFIRM_TEXT: 'লেখা মেলেনি—ঠিক "সব মুছুন" লিখুন।', WRONG_PASSWORD: 'পাসওয়ার্ড ভুল।', BACKUP_REQUIRED: 'আগে নতুন ব্যাকআপ তৈরি করুন, তারপর আবার চেষ্টা করুন।', ACTIVE_ORDERS: 'চলমান ' + (d.active || '') + 'টি অর্ডার আছে—আগে সেগুলো শেষ বা বাতিল করুন।' };
      if (r.ok && d.ok) alert('✅ ইতিহাস ও অর্ডার মুছে ফেলা হয়েছে। ফাইল মুছেছে: ' + (d.files || 0) + 'টি');
      else alert('❌ ' + (msg[d.error] || 'মুছতে ব্যর্থ, আবার চেষ্টা করুন।'));
    } catch (e) { alert('❌ সংযোগ ব্যর্থ, আবার চেষ্টা করুন।'); }
  };
