# All In One (Abc Authentic) - সম্পূর্ণ Specification
## User দিয়েছেন 2026-10-11 03:09 +06

---

## এডমিন প্যানেল

**ID/Password/Email System:**
- ID, Password, Email system করবে
- OTP দিয়ে verify করবে
- Admin দেখবে, আরো উন্নত (advanced) হতে হবে
- Admin ID/password পরিবর্তন করতে পারবে
- User-ও নিজের user/password setup/reset করতে পারবে

**Admin Self-Protection:**
- Admin নিজের account নিজে DELETE করতে পারবে না
- Role পরিবর্তন: সকল user-এ রাখবে না - আলাদা রাখবে, প্রয়োজনে ব্যবহার করবে
- Admin নিজের role পরিবর্তন করতে পারবে না
- অন্যদের role পরিবর্তন করতে পারবে

**User Management:**
- ✅ User ও User data DELETE করতে পারবে - reconfirm হয়ে
  - যা যা delete হবে: User account/profile, সব orders (সব status), Wallet balance ও transactions, Payment/recharge requests, Coupons (cashback/promo), Notices, Chat messages, Uploaded documents
- ✅ প্রতিটা user create করতে পারবে
- ✅ Registration system control ON/OFF

**Per-User Control:**
- ✅ প্রতিটা user-এর সেবা/সার্ভিসের মূল্য নির্ধারণ control
- ✅ ধর্ম নির্ধারণ
- ✅ সেবা access নির্ধারণ
- ✅ প্রতিটা user-এ আলাদা notice - hover animation-এ push করবে
- ✅ User-এর balance control

---

## ড্যাশবোর্ড
- 💯 Dashboard clear থাকবে
- Uncommon সেরা পদ্ধতি - দেখতে আনন্দ, হিজিবিজি নয়
- Scroll ছাড়া - প্রয়োজনে ➤ click করে ভেতরে যাবে

---

## সার্ভিস ম্যানেজমেন্ট
- ✅ Service create করা যাবে + Delete করা যাবে + Serial নির্ধারণ করা যাবে
- User-এ কিভাবে দেখাবে (admin control করবে)
- Manual service create-এ: Documents upload system থাকবে, কি fill করতে হবে তা থাকবে
- Automated/API service রাখবে
- বাকিগুলো logic-এ থাকবে

---

## অর্ডার
- 🚨 Status: নতুন / অপেক্ষমান / প্রসেসিং / সম্পন্ন / ডেলিভার্ড / ব্যর্থ / বাতিল / রিফান্ডেড
- এগুলো logic-এ সেরাভাবে দিবে

---

## কাস্টমার পেমেন্ট রিকোয়েস্ট
- ✅ বিকাশ পেমেন্ট, বিকাশ পার্সোনাল, নগদ ও রকেট (uncommon design দিও)
- অবশ্যই দুই পদ্ধতিতে পেমেন্ট গ্রহণ - মনে রাখবে
- SMS auto-match secret - ভুলবে না!
- Request আসলে: voice দিয়ে সেরাভাবে জানিয়ে দিবে
  - Ringtone সময় logic-এ
  - Voice সেরা, সুন্দর, মনোরম হতে হবে
- (Auto + Manual)

---

## ক্যাশব্যাক কুপন সিস্টেম
- Customer-এর ব্যবহারের ভিত্তিতে নির্দিষ্ট percent-এ cashback coupon redeem করতে পারবে
- Auto হবে: "তৈরী করুন" click করলে coupon code বসে যাবে, "Redeem" click করলে মূল balance-এ add হবে
- আকর্ষণীয় design-এ user-এ দেখাবে
- Percent নির্ধারণ করবে admin

---

## প্রোমো কোড
- ✅ Admin promo code দিতে পারবে, user তাদের option-এ ব্যবহার করে redeem করবে
- অর্থাৎ promo code শুধুমাত্র wallet-এই ব্যবহার্য
- Admin নির্বাচন করে দিতে পারবে কোন service-এ এই code ব্যবহার করতে পারবে

---

## ব্যানার / বিজ্ঞাপন / পপআপ
- কয়েকটা design-এ: User dashboard-এ banner / advertisement / popup = সেরা
- Admin panel-এ: Ready-made ১৫-২০ sample design থাকবে
- প্রতি banner/ad/popup-এর সেরা animated design

---

## ধর্মভিত্তিক গ্রিটিং
- User dashboard-এ: হিন্দু / মুসলিম / বৌদ্ধ / খ্রিস্টান - আলাদা আলাদা সামান্য icon বা animation
- হিন্দু: নমস্কার ইত্যাদি logic-এ
- পুরুষ / মহিলা / শিশু voice পালাবদলে শোনাবে
- সবসময় না - শুধু যখন login করে প্রবেশ করবে

---

## সেবা ডিসপ্লে
- সেবাগুলো আলাদা আলাদা দেখাবে - সুন্দর uncommon পদ্ধতিতে
- Automated আর Manual ➤
- নিবন্ধন সেবা অনেক হলে: নিবন্ধন click করলে সব সেবা একসাথে - এভাবে logic-এ দিবে

---

## ইউজার ওয়ালেট
- সেরা uncommon হবে, fresh

---

## অর্ডার পদ্ধতি
- দেখবে যাতে বেশি scroll করতে না হয়
- বেশি হলে click-এ যাবে
- হিজিবিজি যাতে না হয়

---

## এডমিন নোটিফিকেশন
- 🚨 যেকোনো message আসলেই: সেরাভাবে জানাবে, নাম উল্লেখ করে ইত্যাদি logic-এ

---

## হোয়াটসঅ্যাপ ও চ্যাট
- WhatsApp button: সেরাভাবে দেখাবে user-এ
- Chat: শুধু logic-এ - কোনো অভিযোগ, কোনো order-এ কিছু বলতে হলে, review ইত্যাদিতে
- এটা dashboard-এ show হবে না
- প্রতিটা service-এ নিয়ম আকর্ষণীয়ভাবে দিবে (popup হোক বা uncommon-এ)
- User dashboard সেরা হবে, logic-এ

---

## ডিজাইন
- #9 Coffee (espresso + gold, premium)
- No-scroll hub
- Uncommon animations
- WhatsApp button = THE BEST, uncommon animated
- Auto user info (name/ID/phone) on WhatsApp click

---

## অতিরিক্ত ফিচার (User approved 2026-10-11)

**Activity Log:**
- কে কখন কি করলো (user delete, balance change, role change) - প্রমাণ থাকবে
- Admin দেখতে পারবে

**Backup System:**
- Database backup - কখন, কোথায় (logic-এ)

**Search/Filter:**
- Admin panel-এ order/user/service খোঁজার system

**Report Export:**
- PDF format-এ report download

**Maintenance Mode:**
- Site বন্ধ রাখার option (admin control)

**Password Policy:**
- Minimum length ও complexity (logic-এ)

**Login Attempt Limit:**
- ভুল password-এ limit (যেমন: ৫ বার ভুল → block)
- Admin চাইলে unblock করতে পারবে

---

## আরো ফিচার (User approved 2026-10-11)

**User Profile:**
- নিজের তথ্য edit করতে পারবে (name, phone etc.)

**Order Tracking Timeline:**
- Order কোথায় আছে - timeline-এ দেখবে

**Transaction History:**
- Wallet-এর বিস্তারিত transaction list

**Admin Dashboard Statistics:**
- আজকের order, revenue, নতুন user etc.

**Bulk Action:**
- একসাথে অনেক order/user select করে action

**Session Timeout:**
- নির্দিষ্ট সময় পর auto logout (logic-এ)

**Welcome Bonus:**
- নতুন user-এ bonus (admin control)

**Order Status Animation Page:**
- Order করার পর user-কে নতুন page-এ নিবে
- Animation-এ দেখাবে কোন অবস্থায় আছে (received → processing → completed etc.)

**File Upload:**
- Limit admin নির্ধারণ করবে (MB, file type)
- Admin panel থেকে configure করা যাবে

**Chat System:**
- Order detail page-এ থাকবে (contextual)
- Complaint, order সম্পর্কে কিছু বলা, review - এগুলোর জন্য
