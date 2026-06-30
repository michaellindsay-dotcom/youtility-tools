import { useRef, useState } from "react";
import { ref as storageRef, uploadBytes } from "firebase/storage";
import { addDoc, collection } from "firebase/firestore";
import { db, storage } from "../firebase";

const CONSENT_KEY = "yk.pitchConsent";

// Browser support: needs mic capture + MediaRecorder (HTTPS only).
export const pitchSupported =
  typeof navigator !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof window !== "undefined" &&
  "MediaRecorder" in window;

interface PitchMeta {
  companyId: string;
  uid: string;
  userName?: string;
  managerPath: string[];
  leadId?: string | null;
  address?: string;
  // "door" (default) = a real pitch at a door; "certification" = a practice/role-play
  // pitch that, if it scores high enough, certifies the rep for full-credit knocks.
  kind?: "door" | "certification";
}

// Records the rep's door pitch while the disposition flow is open, then uploads
// the audio + creates a `pitches/{id}` doc the AI pipeline picks up. Recording
// only ever starts after the rep has given one-time consent.
export function usePitchRecorder() {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef<number>(0);
  const [recording, setRecording] = useState(false);
  const [consented, setConsented] = useState<boolean>(
    () => typeof localStorage !== "undefined" && localStorage.getItem(CONSENT_KEY) === "1"
  );

  const giveConsent = () => {
    try { localStorage.setItem(CONSENT_KEY, "1"); } catch { /* ignore */ }
    setConsented(true);
  };

  const start = async () => {
    if (!pitchSupported || !consented || recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
      mr.start();
      recorderRef.current = mr;
      startedAtRef.current = Date.now();
      setRecording(true);
    } catch (e) {
      // Denied mic / no device — silently skip; never block the lead flow.
      console.warn("pitch recorder: mic unavailable", e);
    }
  };

  const cleanup = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setRecording(false);
  };

  // Stop, upload the audio, and create the pitch doc. Best-effort: returns the
  // pitch id, or null if there was nothing to save / it failed.
  const stopAndUpload = async (meta: PitchMeta): Promise<string | null> => {
    const mr = recorderRef.current;
    if (!mr) return null;
    recorderRef.current = null; // claim it so a later discard() is a no-op
    const mime = mr.mimeType || "audio/webm";
    const durationMs = Date.now() - startedAtRef.current;
    let blob: Blob;
    try {
      blob = await new Promise<Blob>((resolve) => {
        mr.onstop = () => resolve(new Blob(chunksRef.current, { type: mime }));
        mr.stop();
      });
    } catch (e) {
      console.warn("pitch recorder: stop failed", e);
      cleanup();
      return null;
    }
    cleanup();
    if (!blob.size) return null;
    try {
      const ext = mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : "webm";
      const path = `pitches/${meta.companyId}/${meta.uid}/${Date.now()}.${ext}`;
      await uploadBytes(storageRef(storage, path), blob, { contentType: mime });
      const docRef = await addDoc(collection(db, "pitches"), {
        companyId: meta.companyId,
        uid: meta.uid,
        userName: meta.userName || "",
        managerPath: meta.managerPath || [],
        visibilityPath: [meta.uid, ...(meta.managerPath || [])],
        leadId: meta.leadId || null,
        address: meta.address || "",
        audioPath: path,
        durationMs,
        kind: meta.kind || "door",
        status: "recorded",
        createdAt: Date.now(),
      });
      return docRef.id;
    } catch (e) {
      console.warn("pitch recorder: upload failed", e);
      return null;
    }
  };

  // Discard without uploading (rep closed the modal without saving).
  const discard = () => {
    const mr = recorderRef.current;
    try { if (mr && mr.state !== "inactive") mr.stop(); } catch { /* ignore */ }
    cleanup();
  };

  return { recording, consented, giveConsent, start, stopAndUpload, discard };
}
