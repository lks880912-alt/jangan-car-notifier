// 법인차량 예약 시스템 – 알림 자동 발송기 (GitHub Actions에서 10분마다 실행)
const admin = require("firebase-admin");

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const fcm = admin.messaging();
const { FieldValue } = admin.firestore;
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, ""); // 8단계 배포 후 설정 (선택)

const MIN = 60 * 1000, HOUR = 60 * MIN;
const kst = (d) => new Date(d.getTime() + 9 * HOUR).toISOString().slice(0, 16); // 한국시간 "2026-11-17T09:00"
const toDate = (k) => new Date(k + ":00+09:00");
const fmt = (k) => `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))} ${k.slice(11, 16)}`;

async function main() {
  const now = new Date();
  const since = kst(new Date(now - 3 * 24 * HOUR));

  const [recent, canceled] = await Promise.all([
    db.collection("reservations").where("end", ">=", since).get(),
    db.collection("reservations").where("notifyPending", "==", true).get(),
  ]);

  const jobs = [];   // 보낼 알림
  const flags = [];  // 예약에 남길 "보냄" 표시

  for (const d of recent.docs) {
    const r = d.data();
    if (r.status !== "ok") continue;
    const sent = r.notified || {};
    const start = toDate(r.start), end = toDate(r.end);
    const car = `${r.vehicleName} ${r.plate}`;
    const created = r.createdAt ? r.createdAt.toDate() : now;

    // 1) 예약 확정 + 동승자 추가 (만든 지 하루 이내 예약만)
    if (!sent.confirm) {
      if (now - created < 24 * HOUR) {
        jobs.push({ userId: r.driverId, type: "confirm", title: "예약이 확정됐어요", body: `${car} · ${fmt(r.start)} ~ ${fmt(r.end)}` });
        for (const p of r.passengers || []) {
          jobs.push({ userName: p, type: "confirm", title: "동승자로 추가됐어요",
            body: `${r.driverName}님의 ${fmt(r.start)} ${r.vehicleName} 예약에 동승자로 추가됐어요.` });
        }
      }
      flags.push([d.ref, { "notified.confirm": true }]);
    }

    // 2) 출발 1시간 전
    if (!sent.before && start > now && start - now <= HOUR) {
      jobs.push({ userId: r.driverId, type: "before", title: "1시간 뒤 출발이에요", body: `${car} · ${fmt(r.start)} 출발 · ${r.dest}` });
      flags.push([d.ref, { "notified.before": true }]);
    }

    // 3) 반납 30분 전
    if (!sent.ret && !r.tripDone && end > now && end - now <= 30 * MIN) {
      jobs.push({ userId: r.driverId, type: "ret", title: "반납 시간이 30분 남았어요",
        body: `${car} · ${fmt(r.end)} 반납 예정. 운행일지·주유 입력도 잊지 마세요.` });
      flags.push([d.ref, { "notified.ret": true }]);
    }

    // 4) 반납 30분 지났는데 운행일지 없음 → 예약자 + 관리자
    if (!sent.late && !r.tripDone && now - end >= 30 * MIN) {
      if (now - end <= 24 * HOUR) {
        jobs.push({ userId: r.driverId, type: "ret", title: "운행일지를 아직 안 썼어요",
          body: `${fmt(r.start)} ${r.vehicleName} 운행의 도착 km와 주유 비용을 입력해 주세요.` });
        jobs.push({ admins: true, type: "admin", title: "반납이 늦어지고 있어요",
          body: `${car} · ${r.driverName} · 반납 예정 ${fmt(r.end)} (운행일지 미입력)` });
      }
      flags.push([d.ref, { "notified.late": true }]);
    }
  }

  // 5) 관리자 취소
  for (const d of canceled.docs) {
    const r = d.data();
    jobs.push({ userId: r.driverId, type: "cancel", title: "예약이 취소됐어요",
      body: `관리자가 ${fmt(r.start)} ${r.vehicleName} 예약을 취소했어요. 사유: ${r.cancelReason || "관리자 취소"}` });
    flags.push([d.ref, { notifyPending: false }]);
  }

  if (jobs.length) await send(jobs);

  // "보냄" 표시 저장
  for (let i = 0; i < flags.length; i += 400) {
    const batch = db.batch();
    flags.slice(i, i + 400).forEach(([ref, data]) => batch.update(ref, data));
    await batch.commit();
  }
  console.log(`알림 ${jobs.length}건 처리, 표시 ${flags.length}건 (${kst(now)} KST)`);
}

async function send(jobs) {
  const [uSnap, dSnap] = await Promise.all([db.collection("users").get(), db.collection("devices").get()]);
  const users = uSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((u) => u.active !== false);
  const devices = dSnap.docs.map((d) => ({ ref: d.ref, ...d.data() }));

  const targets = (j) =>
    j.userId ? [j.userId]
    : j.userName ? users.filter((u) => u.name === j.userName).map((u) => u.id)
    : users.filter((u) => u.role === "관리자").map((u) => u.id);

  const out = []; // [메시지, 기기]
  for (const j of jobs) {
    for (const uid of targets(j)) {
      // 알림함에 저장
      await db.collection("notifications").add({
        userId: uid, type: j.type, title: j.title, body: j.body, read: false, createdAt: FieldValue.serverTimestamp(),
      });
      // 그 사람의 휴대폰들로 푸시
      for (const dv of devices.filter((x) => x.userId === uid && x.pushOn && x.fcmToken)) {
        if (j.type !== "cancel" && dv.prefs && dv.prefs[j.type] === false) continue; // 사용자가 끈 알림
        const msg = { token: dv.fcmToken, notification: { title: j.title, body: j.body }, webpush: { notification: {} } };
        if (APP_URL) {
          msg.webpush.notification.icon = APP_URL + "/icon-192.png";
          msg.webpush.fcmOptions = { link: APP_URL };
        }
        out.push([msg, dv]);
      }
    }
  }

  for (let i = 0; i < out.length; i += 500) {
    const chunk = out.slice(i, i + 500);
    const res = await fcm.sendEach(chunk.map(([m]) => m));
    res.responses.forEach((r, k) => {
      if (r.success) return;
      const code = r.error?.code || "";
      console.log("푸시 실패:", code);
      // 앱을 지웠거나 알림을 끈 기기 → 토큰 정리
      if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) {
        chunk[k][1].ref.update({ pushOn: false, fcmToken: FieldValue.delete() });
      }
    });
    console.log(`푸시 ${res.successCount}건 성공 / ${res.failureCount}건 실패`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
