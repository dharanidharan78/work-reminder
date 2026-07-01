/* eslint-disable no-undef */
// ─── FIREBASE MESSAGING SERVICE WORKER ────────────────────
// This file MUST live at /public/firebase-messaging-sw.js (served
// from the site root) — that's a hard requirement of FCM's web SDK.
// It runs in the background, separate from your React app, which is
// what lets notifications appear even when the tab/browser is closed.

importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyBCXvKsURDwdds9Z3viJ-9qTcFhk0ypdOs",
  authDomain: "workflow-fb565.firebaseapp.com",
  projectId: "workflow-fb565",
  storageBucket: "workflow-fb565.firebasestorage.app",
  messagingSenderId: "880448325204",
  appId: "1:880448325204:web:e66e6c19c85f223a108fc1",
});

const messaging = firebase.messaging();

// Fires when a push arrives while the app is NOT in focus
// (other tab, minimized, or browser closed but OS keeps the SW alive)
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || "WORK FLOW Reminder";
  const body = payload.notification?.body || "You have a task due.";

  self.registration.showNotification(title, {
    body,
    icon: "/favicon.ico",
    badge: "/favicon.ico",
    tag: "workflow-reminder",
    renotify: true,
    data: payload.data || {},
  });
});

// Clicking the notification focuses/opens the app
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow("/");
    })
  );
});
