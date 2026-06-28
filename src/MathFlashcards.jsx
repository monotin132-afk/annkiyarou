import React, { useState, useRef, useEffect } from "react";
import { storage } from "./storage";

// ---------- ユーティリティ ----------
const uid = () => Math.random().toString(36).slice(2, 10);
const LEVELS = 5; // 習熟度レベル 0(苦手)〜4(得意)

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve({ src: reader.result, width: img.width, height: img.height });
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// スマホのカメラ写真は非常に高解像度（数千px・数MB）になることがあるため、
// 読み込み速度やメモリ使用量を抑える目的で長辺を MAX_DIMENSION に縮小し、
// JPEG品質を調整する。保存先がIndexedDBになり容量制約は大きく緩和されたため、
// 「フリップカードで見た時に文字が鮮明に読める」ことを優先し、画質を高めに設定する。
const MAX_DIMENSION = 2000;
const INITIAL_JPEG_QUALITY = 0.9;
const TARGET_MAX_BYTES = 3500 * 1024; // dataURL文字列の目安上限（大きめに許容）

function resizeImage(src, originalWidth, originalHeight) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_DIMENSION / Math.max(originalWidth, originalHeight));
      const w = Math.max(1, Math.round(originalWidth * scale));
      const h = Math.max(1, Math.round(originalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);

      // 品質を段階的に下げ、目標サイズに収まるまで再エンコードする
      let quality = INITIAL_JPEG_QUALITY;
      let dataUrl = canvas.toDataURL("image/jpeg", quality);
      let attempts = 0;
      while (dataUrl.length > TARGET_MAX_BYTES && attempts < 3) {
        quality = Math.max(0.5, quality - 0.12);
        dataUrl = canvas.toDataURL("image/jpeg", quality);
        attempts++;
      }
      resolve({ src: dataUrl, width: w, height: h });
    };
    img.onerror = () => resolve({ src, width: originalWidth, height: originalHeight });
    img.src = src;
  });
}

async function loadAndResizeImage(file) {
  const original = await loadImage(file);
  return resizeImage(original.src, original.width, original.height);
}

function cropImage(srcImg, rect) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const w = Math.max(1, Math.round(rect.w));
      const h = Math.max(1, Math.round(rect.h));
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);

      // トリミング後のカード画像は学習中に拡大して見るため、できるだけ高品質を優先する
      let quality = 0.94;
      let dataUrl = canvas.toDataURL("image/jpeg", quality);
      let attempts = 0;
      while (dataUrl.length > TARGET_MAX_BYTES && attempts < 3) {
        quality = Math.max(0.5, quality - 0.12);
        dataUrl = canvas.toDataURL("image/jpeg", quality);
        attempts++;
      }
      resolve(dataUrl);
    };
    img.src = srcImg;
  });
}

// 自由な形（多角形）でのトリミング。選択範囲外は透過にするため出力はPNG。
// pathPoints は原画像のピクセル座標系での多角形の頂点列。
function cropImageFreeform(srcImg, pathPoints) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const xs = pathPoints.map((p) => p.x);
      const ys = pathPoints.map((p) => p.y);
      const minX = Math.max(0, Math.min(...xs));
      const minY = Math.max(0, Math.min(...ys));
      const maxX = Math.max(...xs);
      const maxY = Math.max(...ys);
      const w = Math.max(1, Math.round(maxX - minX));
      const h = Math.max(1, Math.round(maxY - minY));

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");

      // 多角形パスをクリップ領域として設定してから画像を描画することで、
      // パスの外側は透過のまま残る
      ctx.save();
      ctx.beginPath();
      pathPoints.forEach((p, i) => {
        const x = p.x - minX;
        const y = p.y - minY;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(img, -minX, -minY);
      ctx.restore();

      resolve(canvas.toDataURL("image/png"));
    };
    img.src = srcImg;
  });
}

// ---------- 永続化（IndexedDB、storage.js経由） ----------
const STORAGE_META_KEY = "math-flashcards:meta:v1";
const STORAGE_DRAFT_KEY = "math-flashcards:draft:v1";

async function saveMeta(decks, cards, photoLibrary, photoGroups, prefs) {
  // 画像本体(frontSrc/backSrc/src)は別キーに保存するため、メタには含めない
  const cardsMeta = cards.map(({ frontSrc, backSrc, ...rest }) => rest);
  const photosMeta = photoLibrary.map(({ src, ...rest }) => rest);
  const payload = { decks, cards: cardsMeta, photos: photosMeta, photoGroups, prefs: prefs || {} };
  try {
    await storage.set(STORAGE_META_KEY, JSON.stringify(payload));
  } catch (e) {
    console.error("メタ情報の保存に失敗しました", e);
    throw e;
  }
}

// デッキ作成中のドラフト（途中保存）を保存・読み込み・削除する関数群
async function saveDraft(draft) {
  try {
    await storage.set(STORAGE_DRAFT_KEY, JSON.stringify({ ...draft, savedAt: Date.now() }));
  } catch (e) {
    console.error("ドラフトの保存に失敗しました", e);
  }
}

async function loadDraft() {
  try {
    const res = await storage.get(STORAGE_DRAFT_KEY);
    return res ? JSON.parse(res.value) : null;
  } catch {
    return null;
  }
}

async function clearDraft() {
  try {
    await storage.delete(STORAGE_DRAFT_KEY);
  } catch {
    // 存在しない場合は無視
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// IndexedDB のトランザクション競合を避けるため、同時書き込み数を絞ってバッチ処理する。
async function runWithConcurrencyLimit(tasks, limit) {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const current = nextIndex++;
      try {
        await tasks[current]();
        results[current] = { status: "fulfilled" };
      } catch (e) {
        results[current] = { status: "rejected", reason: e };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function saveImageIfChanged(key, value, savedRef) {
  if (savedRef.current.get(key) === value) return; // 変化なしならスキップ
  const MAX_RETRY = 2;
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
      await storage.set(key, value);
      savedRef.current.set(key, value);
      return;
    } catch (e) {
      lastError = e;
      if (attempt < MAX_RETRY) {
        await sleep(300 * (attempt + 1)); // 一時的な失敗を見越して間隔を空けて再試行
      }
    }
  }
  console.error("画像の保存に失敗しました（再試行後も失敗）", key, lastError);
  throw lastError; // 呼び出し元に伝播させ、保存失敗がUIに正しく反映されるようにする
}

async function loadAll() {
  let meta;
  try {
    const res = await storage.get(STORAGE_META_KEY);
    meta = res ? JSON.parse(res.value) : null;
  } catch {
    meta = null;
  }
  if (!meta) return null;

  const { decks = [], cards: cardsMeta = [], photos: photosMeta = [], photoGroups = [], prefs = {} } = meta;

  // 画像本体を並列取得
  const photoResults = await Promise.all(
    photosMeta.map(async (p) => {
      try {
        const res = await storage.get(`photo:${p.id}`);
        return { ...p, src: res ? res.value : null };
      } catch {
        return { ...p, src: null };
      }
    })
  );

  const cardResults = await Promise.all(
    cardsMeta.map(async (c) => {
      const { backSrcExists, ...cardRest } = c;
      const [frontRes, backRes] = await Promise.all([
        storage.get(`card-front:${c.id}`).catch(() => null),
        backSrcExists ? storage.get(`card-back:${c.id}`).catch(() => null) : Promise.resolve(null),
      ]);
      return {
        ...cardRest,
        frontSrc: frontRes ? frontRes.value : null,
        backSrc: backRes ? backRes.value : null,
      };
    })
  );

  return {
    decks,
    cards: cardResults.filter((c) => c.frontType === "text" ? !!c.frontText : !!c.frontSrc),
    photoLibrary: photoResults.filter((p) => p.src),
    photoGroups,
    prefs,
  };
}

// ---------- メインアプリ ----------
export default function MathFlashcards() {
  const [decks, setDecks] = useState([]); // {id, name, cardIds: []}
  const [cards, setCards] = useState([]); // {id, deckId, frontSrc, backSrc, level, seen, correct}
  const [screen, setScreen] = useState("home"); // home | capture | deck | study | select-decks
  const [activeDeckId, setActiveDeckId] = useState(null);
  const [activeCardId, setActiveCardId] = useState(null);
  const [studyQueue, setStudyQueue] = useState(null); // {cardIds, mode}
  const [photoLibrary, setPhotoLibrary] = useState([]); // {id, src, width, height, addedAt, groupId}
  const [photoGroups, setPhotoGroups] = useState([]); // {id, name}
  // 写真ライブラリの「どのグループを表示中か」「並び順」はApp全体で1つだけ持つ。
  // PhotoPicker（表/裏それぞれで別インスタンスになる）の中でstateとして
  // 持つと、表→裏と画面が切り替わるたびに選択がリセットされてしまうため。
  const [activePhotoTab, setActivePhotoTab] = useState("all"); // "all" | "unsorted" | groupId
  const [librarySortOrder, setLibrarySortOrder] = useState("newest"); // "newest" | "oldest"
  const [loading, setLoading] = useState(true);
  const [draftToRestore, setDraftToRestore] = useState(null); // 復元候補のドラフト
  const [restoredDraft, setRestoredDraft] = useState(null); // CaptureScreenに渡す復元済みドラフト
  const [sharedImport, setSharedImport] = useState(null); // URLリンク経由の取り込み候補 {decks, cards}
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
  const [saveErrorDetail, setSaveErrorDetail] = useState(null);
  const [consecutiveSaveFailures, setConsecutiveSaveFailures] = useState(0);
  const savedImagesRef = useRef(new Map()); // 既に保存済みの画像キー→値(差分検知用)
  const hasLoadedRef = useRef(false);

  // 起動時に1回だけ読み込む
  useEffect(() => {
    (async () => {
      const data = await loadAll();
      if (data) {
        setDecks(data.decks);
        setCards(data.cards);
        setPhotoLibrary(data.photoLibrary);
        setPhotoGroups(data.photoGroups || []);
        if (data.prefs?.librarySortOrder) setLibrarySortOrder(data.prefs.librarySortOrder);
        data.cards.forEach((c) => {
          if (c.frontSrc) savedImagesRef.current.set(`card-front:${c.id}`, c.frontSrc);
          if (c.backSrc) savedImagesRef.current.set(`card-back:${c.id}`, c.backSrc);
        });
        data.photoLibrary.forEach((p) => {
          if (p.src) savedImagesRef.current.set(`photo:${p.id}`, p.src);
        });
      }
      // 保存中だったドラフトがあれば復元候補として保持
      const draft = await loadDraft();
      if (draft && draft.pendingCards && draft.pendingCards.length > 0) {
        setDraftToRestore(draft);
      }
      // URLハッシュに共有データがあれば取り込み確認を表示
      const shared = decodeShareUrl(window.location.hash);
      if (shared && Array.isArray(shared.decks) && Array.isArray(shared.cards)) {
        setSharedImport(shared);
        // ハッシュをURLから取り除く（リロードで再度ダイアログが出ないように）
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      hasLoadedRef.current = true;
      setLoading(false);
    })();
  }, []);

  // decks/cards/photoLibrary/photoGroups の変化を検知して保存する
  useEffect(() => {
    if (!hasLoadedRef.current) return;
    setSaveState("saving");
    const timer = setTimeout(async () => {
      try {
        await saveMeta(
          decks,
          cards.map((c) => ({ ...c, backSrcExists: !!c.backSrc })),
          photoLibrary,
          photoGroups,
          { librarySortOrder }
        );
        const imageTasks = [
          ...cards.flatMap((c) => [
            c.frontSrc ? () => saveImageIfChanged(`card-front:${c.id}`, c.frontSrc, savedImagesRef) : null,
            c.backSrc ? () => saveImageIfChanged(`card-back:${c.id}`, c.backSrc, savedImagesRef) : null,
          ]),
          ...photoLibrary.map((p) => () => saveImageIfChanged(`photo:${p.id}`, p.src, savedImagesRef)),
        ].filter(Boolean);
        const results = await runWithConcurrencyLimit(imageTasks, 3);
        const failed = results.filter((r) => r.status === "rejected");
        if (failed.length > 0) {
          const sizes = [
            ...cards.flatMap((c) => [c.frontSrc?.length, c.backSrc?.length]),
            ...photoLibrary.map((p) => p.src?.length),
          ].filter(Boolean);
          const maxKB = sizes.length ? Math.round(Math.max(...sizes) / 1024) : 0;
          console.error("画像保存に失敗した件数:", failed.length, failed.map((f) => f.reason));
          setSaveErrorDetail(
            `${failed.length}件失敗 / 最大${maxKB}KB（${String(failed[0].reason?.message || failed[0].reason).slice(0, 60)}）`
          );
          setSaveState("error");
          setConsecutiveSaveFailures((n) => n + 1);
        } else {
          setSaveErrorDetail(null);
          setSaveState("saved");
          setConsecutiveSaveFailures(0);
        }
      } catch (e) {
        console.error(e);
        setSaveErrorDetail(String(e?.message || e).slice(0, 80));
        setSaveState("error");
        setConsecutiveSaveFailures((n) => n + 1);
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [decks, cards, photoLibrary, photoGroups, librarySortOrder]);

  const deckCards = (deckId) => cards.filter((c) => c.deckId === deckId);

  function addPhotoToLibrary(img, groupId = null) {
    const entry = { id: uid(), ...img, groupId, addedAt: Date.now() };
    setPhotoLibrary((prev) => [entry, ...prev]);
    return entry;
  }

  function createPhotoGroup(name) {
    const id = uid();
    setPhotoGroups((prev) => [...prev, { id, name }]);
    return id;
  }

  function renamePhotoGroup(groupId, name) {
    setPhotoGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, name } : g)));
  }

  function deletePhotoGroup(groupId) {
    setPhotoGroups((prev) => prev.filter((g) => g.id !== groupId));
    // グループに属していた写真は「未分類」に戻す（写真自体は消さない）
    setPhotoLibrary((prev) => prev.map((p) => (p.groupId === groupId ? { ...p, groupId: null } : p)));
  }

  function setPhotoGroup(photoId, groupId) {
    setPhotoLibrary((prev) => prev.map((p) => (p.id === photoId ? { ...p, groupId } : p)));
  }

  // トリミング完了時に「最後に使った日時」を更新する（最近使った写真の表示用）
  function touchPhotoLastUsed(photoId) {
    if (!photoId) return;
    setPhotoLibrary((prev) =>
      prev.map((p) => (p.id === photoId ? { ...p, lastUsedAt: Date.now() } : p))
    );
  }

  // 写真をライブラリから削除する
  function deletePhoto(photoId) {
    setPhotoLibrary((prev) => prev.filter((p) => p.id !== photoId));
    // その写真を使っているカードの参照は残るが表示は壊れないので特に処理不要
  }

  function createDeck(name) {
    const id = uid();
    setDecks((d) => [...d, { id, name, cardIds: [] }]);
    return id;
  }

  function renameDeck(deckId, newName) {
    if (!newName.trim()) return;
    setDecks((prev) => prev.map((d) => (d.id === deckId ? { ...d, name: newName.trim() } : d)));
  }

  function addCardsToDeck(deckId, newCards) {
    const stamped = newCards.map((c) => ({ ...c, deckId }));
    setCards((prev) => [...prev, ...stamped]);
    setDecks((prev) =>
      prev.map((d) => (d.id === deckId ? { ...d, cardIds: [...d.cardIds, ...stamped.map((c) => c.id)] } : d))
    );
  }

  function updateCardResult(cardId, known) {
    setCards((prev) =>
      prev.map((c) => {
        if (c.id !== cardId) return c;
        const seen = c.seen + 1;
        const correct = c.correct + (known ? 1 : 0);
        let level = c.level;
        if (known) level = Math.min(LEVELS - 1, level + 1);
        else level = 0;
        return { ...c, seen, correct, level };
      })
    );
  }

  function updateCard(cardId, patch) {
    setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, ...patch } : c)));
  }

  function toggleStarred(cardId) {
    setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, starred: !c.starred } : c)));
  }

  // 指定カードIDの習熟度・統計をリセットする（「最初からやり直す」用）
  function resetLevels(cardIds) {
    const idSet = new Set(cardIds);
    setCards((prev) =>
      prev.map((c) => (idSet.has(c.id) ? { ...c, level: 0, seen: 0, correct: 0 } : c))
    );
  }

  function deleteCard(cardId) {
    setCards((prev) => prev.filter((c) => c.id !== cardId));
    setDecks((prev) =>
      prev.map((d) => ({ ...d, cardIds: d.cardIds.filter((id) => id !== cardId) }))
    );
  }

  function deleteDeck(deckId) {
    setCards((prev) => prev.filter((c) => c.deckId !== deckId));
    setDecks((prev) => prev.filter((d) => d.id !== deckId));
  }

  async function exportAllData() {
    const payload = { version: 2, exportedAt: Date.now(), decks, cards, photoLibrary, photoGroups };
    return JSON.stringify(payload);
  }

  function importAllData(json) {
    try {
      const data = JSON.parse(json);
      if (!data || !Array.isArray(data.decks) || !Array.isArray(data.cards)) {
        throw new Error("ファイルの形式が正しくありません");
      }
      setDecks(data.decks);
      setCards(data.cards);
      setPhotoLibrary(data.photoLibrary || []);
      setPhotoGroups(data.photoGroups || []);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function startStudy(cardIds, mode) {
    if (cardIds.length === 0) return;
    setStudyQueue({ cardIds, mode });
    setScreen("study");
  }

  if (loading) {
    return (
      <div style={styles.app}>
        <GlobalStyles />
        <div style={styles.screen}>
          <div style={styles.emptyState}>
            <div style={styles.emptyGlyph}>…</div>
            <p style={styles.emptyText}>保存されたデッキを読み込んでいます</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.app}>
      <GlobalStyles />
      <SaveIndicator state={saveState} detail={saveErrorDetail} />

      {/* ドラフト復元確認ダイアログ（ホーム画面でのみ表示） */}
      {draftToRestore && screen === "home" && (
        <div style={styles.confirmOverlay}>
          <div style={styles.confirmDialog}>
            <p style={styles.confirmTitle}>前回の途中データがあります</p>
            <p style={styles.subText}>
              {new Date(draftToRestore.savedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              に作成中だった{draftToRestore.deckName ? `「${draftToRestore.deckName}」` : "デッキ"}
              （{draftToRestore.pendingCards.length}枚）の続きから再開できます。
            </p>
            <div style={styles.rowButtons}>
              <button
                style={styles.secondaryBtn}
                onClick={async () => {
                  await clearDraft();
                  setDraftToRestore(null);
                }}
              >
                捨てる
              </button>
              <button
                style={styles.primaryBtnFlex}
                onClick={async () => {
                  // IndexedDB上のドラフトをここで消す。
                  // 再開後にリロードしても同じダイアログが再出現しないようにするため。
                  // （CaptureScreenでカードを追加すれば再び保存される）
                  await clearDraft();
                  setRestoredDraft(draftToRestore);
                  setDraftToRestore(null);
                  setActiveDeckId(draftToRestore.activeDeckId || null);
                  setScreen(draftToRestore.addMode ? "capture-add" : "capture");
                }}
              >
                続きから再開する
              </button>
            </div>
          </div>
        </div>
      )}

      {sharedImport && (
        <div style={styles.confirmOverlay}>
          <div style={styles.confirmDialog}>
            <p style={styles.confirmTitle}>カードを取り込みますか？</p>
            <p style={styles.subText}>
              共有リンクから {sharedImport.decks.length} デッキ・{sharedImport.cards.length} 枚のカードを受け取りました。
              取り込むと、今このブラウザに保存されているデータはすべて上書きされます。
            </p>
            <div style={styles.rowButtons}>
              <button style={styles.secondaryBtn} onClick={() => setSharedImport(null)}>
                キャンセル
              </button>
              <button
                style={styles.primaryBtnFlex}
                onClick={() => {
                  const result = importAllData(JSON.stringify(sharedImport));
                  setSharedImport(null);
                  if (!result.ok) alert(`取り込みに失敗しました：${result.error}`);
                }}
              >
                取り込む
              </button>
            </div>
          </div>
        </div>
      )}

      {screen === "home" && (
        <HomeScreen
          decks={decks}
          cards={cards}
          onNewDeck={() => setScreen("capture")}
          onOpenDeck={(id) => {
            setActiveDeckId(id);
            setScreen("deck");
          }}
          onOpenReviewPicker={() => setScreen("select-decks")}
          onStudyWeakOnly={() => {
            setActiveDeckId(null);
            startStudy(cards.map((c) => c.id), "weak-only");
          }}
          onExport={exportAllData}
          onImport={importAllData}
          onStudyStarred={() => {
            const ids = cards.filter((c) => c.starred).map((c) => c.id);
            if (ids.length > 0) startStudy(ids, "random");
          }}
          onResetAllLevels={() => resetLevels(cards.map((c) => c.id))}
          showBackupWarning={consecutiveSaveFailures >= 3}
        />
      )}

      {screen === "select-decks" && (
        <DeckPickerScreen
          decks={decks}
          cards={cards}
          onBack={() => setScreen("home")}
          onStart={(deckIds, mode) => {
            const ids = cards.filter((c) => deckIds.includes(c.deckId)).map((c) => c.id);
            setActiveDeckId(null);
            startStudy(ids, mode);
          }}
        />
      )}

      {screen === "capture" && (
        <CaptureScreen
          library={photoLibrary}
          onAddPhoto={addPhotoToLibrary}
          photoGroups={photoGroups}
          onCreateGroup={createPhotoGroup}
          onSetPhotoGroup={setPhotoGroup}
          onDeleteGroup={deletePhotoGroup}
          onRenameGroup={renamePhotoGroup}
          onTouchPhotoLastUsed={touchPhotoLastUsed}
          onDeletePhoto={deletePhoto}
          librarySortOrder={librarySortOrder}
          onChangeSortOrder={setLibrarySortOrder}
          activePhotoTab={activePhotoTab}
          onChangeActivePhotoTab={setActivePhotoTab}
          restoredDraft={restoredDraft}
          onSaveDraft={(draft) => saveDraft({ ...draft, addMode: false })}
          onCancel={async () => { await clearDraft(); setRestoredDraft(null); setScreen("home"); }}
          onCreate={(name, newCards) => {
            clearDraft();
            setRestoredDraft(null);
            const id = createDeck(name);
            addCardsToDeck(id, newCards);
            setActiveDeckId(id);
            setScreen("deck");
          }}
        />
      )}

      {screen === "deck" && activeDeckId && (
        <DeckScreen
          deck={decks.find((d) => d.id === activeDeckId)}
          cards={deckCards(activeDeckId)}
          onBack={() => setScreen("home")}
          onAddMore={() => setScreen("capture-add")}
          onStudy={(mode) => startStudy(deckCards(activeDeckId).map((c) => c.id), mode)}
          onStudyStarred={(cardIds) => startStudy(cardIds, "random")}
          onRenameDeck={(name) => renameDeck(activeDeckId, name)}
          onOpenCard={(cardId) => {
            setActiveCardId(cardId);
            setScreen("edit-card");
          }}
          onToggleStar={toggleStarred}
          onResetLevels={(cardIds) => resetLevels(cardIds)}
          onDeleteDeck={() => {
            deleteDeck(activeDeckId);
            setActiveDeckId(null);
            setScreen("home");
          }}
        />
      )}

      {screen === "edit-card" && activeCardId && (
        <EditCardScreen
          card={cards.find((c) => c.id === activeCardId)}
          library={photoLibrary}
          onAddPhoto={addPhotoToLibrary}
          photoGroups={photoGroups}
          onCreateGroup={createPhotoGroup}
          onSetPhotoGroup={setPhotoGroup}
          onDeleteGroup={deletePhotoGroup}
          onRenameGroup={renamePhotoGroup}
          onTouchPhotoLastUsed={touchPhotoLastUsed}
          onDeletePhoto={deletePhoto}
          librarySortOrder={librarySortOrder}
          onChangeSortOrder={setLibrarySortOrder}
          activePhotoTab={activePhotoTab}
          onChangeActivePhotoTab={setActivePhotoTab}
          onBack={() => setScreen("deck")}
          onUpdate={(patch) => updateCard(activeCardId, patch)}
          onToggleStar={() => toggleStarred(activeCardId)}
          onDelete={() => {
            deleteCard(activeCardId);
            setActiveCardId(null);
            setScreen("deck");
          }}
        />
      )}

      {screen === "capture-add" && activeDeckId && (
        <CaptureScreen
          addMode
          library={photoLibrary}
          onAddPhoto={addPhotoToLibrary}
          photoGroups={photoGroups}
          onCreateGroup={createPhotoGroup}
          onSetPhotoGroup={setPhotoGroup}
          onDeleteGroup={deletePhotoGroup}
          onRenameGroup={renamePhotoGroup}
          onTouchPhotoLastUsed={touchPhotoLastUsed}
          onDeletePhoto={deletePhoto}
          librarySortOrder={librarySortOrder}
          onChangeSortOrder={setLibrarySortOrder}
          activePhotoTab={activePhotoTab}
          onChangeActivePhotoTab={setActivePhotoTab}
          deckName={decks.find((d) => d.id === activeDeckId)?.name}
          restoredDraft={restoredDraft}
          onSaveDraft={(draft) => saveDraft({ ...draft, addMode: true, activeDeckId })}
          onCancel={async () => { await clearDraft(); setRestoredDraft(null); setScreen("deck"); }}
          onCreate={(_, newCards) => {
            clearDraft();
            setRestoredDraft(null);
            addCardsToDeck(activeDeckId, newCards);
            setScreen("deck");
          }}
        />
      )}

      {screen === "study" && studyQueue && (
        <StudyScreen
          cards={cards.filter((c) => studyQueue.cardIds.includes(c.id))}
          mode={studyQueue.mode}
          onResult={updateCardResult}
          onToggleStar={toggleStarred}
          onExit={() => {
            setStudyQueue(null);
            setScreen(activeDeckId ? "deck" : "home");
          }}
        />
      )}
    </div>
  );
}

// ---------- ホーム画面 ----------
function HomeScreen({
  decks,
  cards,
  onNewDeck,
  onOpenDeck,
  onOpenReviewPicker,
  onStudyWeakOnly,
  onStudyStarred,
  onResetAllLevels,
  onExport,
  onImport,
  showBackupWarning,
}) {
  const totalCards = cards.length;
  const weakCount = cards.filter((c) => c.level <= 1).length;
  const starredCount = cards.filter((c) => c.starred).length;
  const [confirmingReset, setConfirmingReset] = useState(false);

  return (
    <div style={styles.screen}>
      <header style={styles.header}>
        <div style={styles.eyebrow}>すごい暗記帳</div>
        <h1 style={styles.h1}>数学カード</h1>
      </header>

      {showBackupWarning && (
        <div style={styles.backupWarning}>
          <p style={styles.backupWarningTitle}>自動保存がうまく動いていないようです</p>
          <p style={styles.backupWarningText}>
            このままだと変更が失われる可能性があります。下の「データの引っ越し」からファイルに書き出しておくことをおすすめします。
          </p>
        </div>
      )}

      {decks.length === 0 ? (
        <div style={styles.emptyState}>
          <div style={styles.emptyGlyph}>∫</div>
          <p style={styles.emptyText}>写真を撮って最初の単元を作りましょう</p>
          <button style={styles.primaryBtn} onClick={onNewDeck}>
            ＋ 写真から作成
          </button>
        </div>
      ) : (
        <>
          <div style={styles.statsRow}>
            <StatPill label="カード" value={totalCards} />
            <StatPill
              label="苦手"
              value={weakCount}
              accent
              onClick={weakCount > 0 ? onStudyWeakOnly : undefined}
            />
            <StatPill
              label="★マーク"
              value={starredCount}
              star
              onClick={starredCount > 0 ? onStudyStarred : undefined}
            />
          </div>

          {weakCount > 0 && (
            <button style={styles.weakCta} onClick={onStudyWeakOnly}>
              <span style={styles.weakCtaGlyph}>●</span>
              <span style={styles.reviewCtaText}>
                <span style={styles.weakCtaTitle}>苦手な {weakCount} 枚だけ復習する</span>
                <span style={styles.weakCtaSub}>全デッキの中から苦手なカードだけを出題します</span>
              </span>
            </button>
          )}

          {starredCount > 0 && (
            <button style={styles.starCta} onClick={onStudyStarred}>
              <span style={styles.starCtaGlyph}>★</span>
              <span style={styles.reviewCtaText}>
                <span style={styles.starCtaTitle}>★マークの {starredCount} 枚を復習する</span>
                <span style={styles.starCtaSub}>自分でマークしたカードだけをまとめて出題します</span>
              </span>
            </button>
          )}

          {totalCards > 0 && (
            <button style={styles.reviewCta} onClick={onOpenReviewPicker}>
              <span style={styles.reviewCtaGlyph}>⟲</span>
              <span style={styles.reviewCtaText}>
                <span style={styles.reviewCtaTitle}>デッキを選んで総復習</span>
                <span style={styles.reviewCtaSub}>複数の単元をまとめて復習できます</span>
              </span>
            </button>
          )}

          {/* 苦手リセット */}
          {weakCount > 0 && (
            <div style={styles.resetRow}>
              {!confirmingReset ? (
                <button style={styles.dangerLinkBtn} onClick={() => setConfirmingReset(true)}>
                  苦手の記録をリセットして最初からやり直す
                </button>
              ) : (
                <div style={styles.dangerConfirmBox}>
                  <p style={styles.subText}>全デッキの苦手度・出題回数をリセットします。カード自体は削除されません。</p>
                  <div style={styles.rowButtons}>
                    <button style={styles.secondaryBtn} onClick={() => setConfirmingReset(false)}>やめる</button>
                    <button style={styles.dangerBtn} onClick={() => { onResetAllLevels(); setConfirmingReset(false); }}>
                      リセットする
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div style={styles.sectionDivider}>
            <span style={styles.sectionDividerLabel}>デッキ</span>
          </div>

          <div style={styles.deckGrid}>
            {decks.map((d) => {
              const dc = cards.filter((c) => c.deckId === d.id);
              const weak = dc.filter((c) => c.level <= 1).length;
              return (
                <div key={d.id} style={styles.deckCard} onClick={() => onOpenDeck(d.id)}>
                  <div style={styles.deckCardSpine} />
                  <div style={styles.deckCardBody}>
                    <div style={styles.deckCardTitle}>{d.name}</div>
                    <div style={styles.deckCardMeta}>
                      {dc.length} 枚
                      {weak > 0 && <span style={styles.weakTag}> ・ 苦手 {weak}</span>}
                    </div>
                  </div>
                  <div style={styles.deckCardArrow}>›</div>
                </div>
              );
            })}
            <div style={styles.deckCardAdd} onClick={onNewDeck}>
              ＋ 新しいデッキ
            </div>
          </div>
        </>
      )}

      <DataTransferSection onExport={onExport} onImport={onImport} hasData={decks.length > 0} decks={decks} cards={cards} />
    </div>
  );
}

// ---------- データの書き出し・読み込み（別デバイス・別ブラウザへの引っ越し用） ----------
// ---------- 共有用URLエンコード/デコード ----------
// JSONをbase64urlに圧縮してURLハッシュに埋め込む。
// 画像(base64 dataURL)をそのまま入れるとURLが巨大になるため、
// カードの画像は「含む/含まない」をユーザーが選べるようにする。
// ここではテキストのみのカード（frontType="text", backType="text"|null）のみURLに乗せる。
// 画像入りカードはファイル共有を案内する。

function encodeShareUrl(payload) {
  const json = JSON.stringify(payload);
  // btoa はUTF-8非対応なのでencodeURIComponent経由でエスケープ
  const b64 = btoa(unescape(encodeURIComponent(json)));
  const url = `${window.location.origin}${window.location.pathname}#share=${b64}`;
  return url;
}

function decodeShareUrl(hash) {
  try {
    const match = hash.match(/[#&]share=([^&]*)/);
    if (!match) return null;
    const json = decodeURIComponent(escape(atob(match[1])));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function DataTransferSection({ onExport, onImport, hasData, decks, cards }) {
  const fileRef = useRef(null);
  const [confirming, setConfirming] = useState(false);
  const [pendingJson, setPendingJson] = useState(null); // ファイルまたはURL由来のjson文字列
  const [pendingLabel, setPendingLabel] = useState(""); // 確認ダイアログに表示するラベル
  const [message, setMessage] = useState(null); // {type: 'ok'|'error', text}
  const [sharing, setSharing] = useState(false);

  // ---- 書き出し ----
  // iOS Safari は .json ファイルの Web Share API 共有を Permission denied でブロックする。
  // また async 処理を挟むとユーザージェスチャーが失われ share() が失敗する。
  // そのため以下の優先順位で試みる：
  //   1. PC/Android: <a download> でファイルダウンロード（最も確実）
  //   2. iOS Safari: <a> download が効かないので data: URL を新しいタブで開く
  //      → Safariの「共有」ボタンから AirDrop / ファイルに保存 等を使える
  async function handleExport() {
    try {
      const json = await onExport();
      const date = new Date().toISOString().slice(0, 10);
      const fileName = `math-flashcards-${date}.json`;

      // --- パターン1: <a download>（Chrome/Firefox/Edge/Android）---
      // iOS Safari では download 属性が無視されるが試みる
      const blob = new Blob([json], { type: "application/json" });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();

      // download が機能したかどうかは判別できないため、
      // iOS かどうかでメッセージを出し分ける
      const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

      if (isIOS) {
        // iOS では download が効かないので data: URL で別タブを開く
        // → Safari の共有シートから「ファイルに保存」「AirDrop」等が使える
        URL.revokeObjectURL(blobUrl);
        const dataUrl = "data:application/json;charset=utf-8," + encodeURIComponent(json);
        const newTab = window.open(dataUrl, "_blank");
        if (newTab) {
          setMessage({ type: "ok", text: "新しいタブにデータが開きました。Safari の共有ボタン（□↑）→「ファイルに保存」または AirDrop で保存してください。" });
        } else {
          // ポップアップブロックされた場合はコピー
          await navigator.clipboard.writeText(json).catch(() => {});
          setMessage({ type: "ok", text: "ポップアップがブロックされました。代わりにデータをクリップボードにコピーしました。メモアプリ等に貼り付けて .json として保存してください。" });
        }
      } else {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        setMessage({ type: "ok", text: "書き出しました" });
      }
    } catch (e) {
      if (e?.name === "AbortError") return;
      console.error("書き出しに失敗しました", e);
      setMessage({ type: "error", text: `書き出しに失敗しました：${e.message || e}` });
    }
  }

  // ---- URLリンクで共有（テキストカードのみ） ----
  async function handleShareUrl() {
    // テキストのみのカードだけURLに乗せる
    const textCards = cards.filter((c) => c.frontType === "text");
    if (textCards.length === 0) {
      setMessage({ type: "error", text: "URLで共有できるのはテキストカードのみです。写真入りカードはファイルで書き出してください。" });
      return;
    }

    // テキストカードが属するデッキだけを絞る
    const deckIdsInTextCards = new Set(textCards.map((c) => c.deckId));
    const textDecks = decks.filter((d) => deckIdsInTextCards.has(d.id));

    const payload = {
      version: 2,
      exportedAt: Date.now(),
      decks: textDecks,
      cards: textCards.map((c) => ({
        ...c,
        frontSrc: null,
        backSrc: null,
      })),
      photoLibrary: [],
      photoGroups: [],
    };

    const shareUrl = encodeShareUrl(payload);

    try {
      if (navigator.share) {
        await navigator.share({ title: "数学カード", text: "このリンクを開くとカードを取り込めます", url: shareUrl });
        setMessage({ type: "ok", text: "URLを共有しました" });
      } else {
        await navigator.clipboard.writeText(shareUrl);
        setMessage({ type: "ok", text: "URLをコピーしました。相手に送ってください。" });
      }
    } catch (e) {
      if (e?.name === "AbortError") return;
      // clipboardもだめなら手動コピー用に表示
      setSharing(shareUrl);
    }
  }

  // ---- ファイル読み込み ----
  function handleFileSelected(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((text) => {
      setPendingJson(text);
      setPendingLabel(`ファイル「${file.name}」`);
      setConfirming(true);
    });
    e.target.value = "";
  }

  function confirmImport() {
    if (!pendingJson) return;
    const result = onImport(pendingJson);
    setConfirming(false);
    setPendingJson(null);
    setMessage(
      result.ok
        ? { type: "ok", text: "読み込みました" }
        : { type: "error", text: `読み込みに失敗しました：${result.error}` }
    );
  }

  const imageCardCount = cards.filter((c) => c.frontType === "image").length;
  const textCardCount = cards.filter((c) => c.frontType === "text").length;

  return (
    <div style={styles.dataSection}>
      <div style={styles.sectionDivider}>
        <span style={styles.sectionDividerLabel}>共有・引っ越し</span>
      </div>

      {/* 書き出し（ファイル） */}
      <p style={styles.shareMethodLabel}>📁 ファイルで共有（全カード対応）</p>
      <p style={styles.subText}>
        AirDrop・LINEなどで送れるファイルを作ります。写真入りカードも含めて全部まとめて送れます。
      </p>
      <button style={styles.secondaryBtnFull} disabled={!hasData} onClick={handleExport}>
        書き出す・共有する
      </button>

      {/* URLリンクで共有（テキストカードのみ） */}
      <p style={{ ...styles.shareMethodLabel, marginTop: 20 }}>🔗 URLリンクで共有（テキストカードのみ）</p>
      <p style={styles.subText}>
        リンクを送るだけで相手がそのまま取り込めます。
        {imageCardCount > 0 && textCardCount === 0 && (
          <span style={{ color: "#B5482F" }}> このデッキは写真カードのみのためURL共有はできません。ファイルを使ってください。</span>
        )}
        {imageCardCount > 0 && textCardCount > 0 && (
          <span style={{ color: "#8B8270" }}> ※写真カード {imageCardCount} 枚はURLに含まれません（テキストカード {textCardCount} 枚のみ共有）。</span>
        )}
      </p>
      <button
        style={styles.secondaryBtnFull}
        disabled={!hasData || textCardCount === 0}
        onClick={handleShareUrl}
      >
        URLをコピー・共有する
      </button>

      {/* 読み込み */}
      <p style={{ ...styles.shareMethodLabel, marginTop: 20 }}>📥 ファイルを読み込む</p>
      <p style={styles.subText}>
        受け取ったファイル（.json）を選んで取り込みます。URLリンクで受け取った場合は自動で取り込み画面が開きます。
      </p>
      <input
        ref={fileRef}
        type="file"
        accept="application/json"
        style={{ display: "none" }}
        onChange={handleFileSelected}
      />
      <button style={styles.secondaryBtnFull} onClick={() => fileRef.current?.click()}>
        ファイルを選んで読み込む
      </button>

      {message && (
        <p style={message.type === "error" ? styles.dataMessageError : styles.dataMessageOk}>
          {message.text}
        </p>
      )}

      {/* URLコピーできなかった場合の手動コピー用ダイアログ */}
      {sharing && (
        <div style={styles.confirmOverlay}>
          <div style={styles.confirmDialog}>
            <p style={styles.confirmTitle}>URLをコピーして送ってください</p>
            <textarea
              readOnly
              value={sharing}
              style={{ ...styles.textArea, fontSize: 11, minHeight: 80 }}
              onFocus={(e) => e.target.select()}
            />
            <button style={styles.primaryBtn} onClick={() => setSharing(false)}>
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* 読み込み確認ダイアログ */}
      {confirming && (
        <div style={styles.confirmOverlay}>
          <div style={styles.confirmDialog}>
            <p style={styles.confirmTitle}>今のデータを置き換えますか？</p>
            <p style={styles.subText}>
              {pendingLabel}を読み込むと、今このブラウザに保存されているデッキ・カードはすべて上書きされます。
            </p>
            <div style={styles.rowButtons}>
              <button
                style={styles.secondaryBtn}
                onClick={() => { setConfirming(false); setPendingJson(null); }}
              >
                やめる
              </button>
              <button style={styles.primaryBtnFlex} onClick={confirmImport}>
                置き換える
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SaveIndicator({ state, detail }) {
  if (state === "idle") return null;
  const label = state === "saving" ? "保存中…" : state === "error" ? "保存に失敗しました" : "保存しました";
  return (
    <div style={{ ...styles.saveIndicator, ...(state === "error" ? styles.saveIndicatorError : {}) }}>
      {label}
      {state === "error" && detail && <div style={styles.saveIndicatorDetail}>{detail}</div>}
    </div>
  );
}

function StatPill({ label, value, accent, star, onClick }) {
  return (
    <div
      style={{
        ...styles.statPill,
        ...(accent ? styles.statPillAccent : {}),
        ...(star ? styles.statPillStar : {}),
        ...(onClick ? styles.statPillClickable : {}),
      }}
      onClick={onClick}
    >
      <div style={{
        ...styles.statValue,
        ...(accent && value > 0 ? styles.statValueAccent : {}),
        ...(star && value > 0 ? styles.statValueStar : {}),
      }}>{value}</div>
      <div style={styles.statLabel}>{label}</div>
    </div>
  );
}

// ---------- デッキ選択（総復習）画面 ----------
function DeckPickerScreen({ decks, cards, onBack, onStart }) {
  const [selected, setSelected] = useState(() => new Set(decks.map((d) => d.id)));

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedCards = cards.filter((c) => selected.has(c.deckId));
  const selectedCount = selectedCards.length;
  const selectedWeakCount = selectedCards.filter((c) => c.level <= 1).length;
  const allSelected = selected.size === decks.length;

  return (
    <div style={styles.screen}>
      <header style={styles.headerRow}>
        <button style={styles.linkBtn} onClick={onBack}>
          ← ホーム
        </button>
      </header>
      <h1 style={styles.h1}>復習するデッキを選ぶ</h1>
      <p style={styles.subText}>選んだデッキのカードを1つの復習セッションにまとめます</p>

      <button
        style={styles.selectAllBtn}
        onClick={() => setSelected(allSelected ? new Set() : new Set(decks.map((d) => d.id)))}
      >
        {allSelected ? "すべて選択を解除" : "すべて選択"}
      </button>

      <div style={styles.pickerList}>
        {decks.map((d) => {
          const dc = cards.filter((c) => c.deckId === d.id);
          const weak = dc.filter((c) => c.level <= 1).length;
          const checked = selected.has(d.id);
          return (
            <div
              key={d.id}
              style={{ ...styles.pickerRow, ...(checked ? styles.pickerRowChecked : {}) }}
              onClick={() => toggle(d.id)}
            >
              <div style={{ ...styles.checkbox, ...(checked ? styles.checkboxChecked : {}) }}>
                {checked && <span style={styles.checkboxMark}>✓</span>}
              </div>
              <div style={styles.pickerRowBody}>
                <div style={styles.pickerRowTitle}>{d.name}</div>
                <div style={styles.pickerRowMeta}>
                  {dc.length} 枚{weak > 0 && <span style={styles.weakTag}> ・ 苦手 {weak}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={styles.pickerFooter}>
        <div style={styles.pickerFooterCount}>
          {selectedCount > 0 ? `${selectedCount} 枚を復習` : "デッキを選んでください"}
        </div>
        <div style={styles.rowButtons}>
          <button
            style={styles.secondaryBtn}
            disabled={selectedWeakCount === 0}
            onClick={() => onStart(Array.from(selected), "weak-only")}
          >
            苦手だけ（{selectedWeakCount}）
          </button>
          <button
            style={styles.primaryBtnFlex}
            disabled={selectedCount === 0}
            onClick={() => onStart(Array.from(selected), "random")}
          >
            ランダムで開始
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- 撮影・トリミング画面 ----------
function CaptureScreen({
  onCancel,
  onCreate,
  addMode,
  deckName,
  library = [],
  onAddPhoto,
  photoGroups = [],
  onCreateGroup,
  onSetPhotoGroup,
  onDeleteGroup,
  onRenameGroup,
  activePhotoTab,
  onChangeActivePhotoTab,
  onTouchPhotoLastUsed,
  onDeletePhoto,
  librarySortOrder = "newest",
  onChangeSortOrder,
  restoredDraft,
  onSaveDraft,
}) {
  // upload-or-pick(front/back) → crop(front/back) → more-or-back → name
  // step は履歴スタックとして保持し、「戻る」で1つ前のステップに戻れるようにする
  const [stepStack, setStepStack] = useState(() => {
    // 復元ドラフトがある場合、more-or-back ステップから再開する
    if (restoredDraft) return ["more-or-back"];
    return [library.length > 0 ? "pick-front" : "upload-front"];
  });
  const step = stepStack[stepStack.length - 1];
  const [activePhoto, setActivePhoto] = useState(null);
  const [deckNameInput, setDeckNameInput] = useState(() => restoredDraft?.deckName || deckName || "");
  const [pendingCards, setPendingCards] = useState(() => restoredDraft?.pendingCards || []);
  const [currentCardIdx, setCurrentCardIdx] = useState(null);

  // onSaveDraft は毎レンダーで新しい関数参照になるため、refで安定化させる。
  // これにより useEffect の依存配列に含めても不要な再実行が起きない。
  const onSaveDraftRef = useRef(onSaveDraft);
  useEffect(() => { onSaveDraftRef.current = onSaveDraft; }, [onSaveDraft]);

  // pendingCardsが変わるたびにデバウンスして自動保存（600ms遅延）
  const draftTimerRef = useRef(null);
  useEffect(() => {
    if (!onSaveDraftRef.current) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      if (pendingCards.length > 0) {
        onSaveDraftRef.current({ pendingCards, deckName: deckNameInput });
      }
    }, 600);
    return () => clearTimeout(draftTimerRef.current);
  }, [pendingCards, deckNameInput]);

  function goTo(nextStep) {
    setStepStack((prev) => [...prev, nextStep]);
  }

  function goBack() {
    if (stepStack.length <= 1) {
      onCancel();
      return;
    }
    setStepStack((prev) => prev.slice(0, -1));
  }

  // 「撮る」: カメラで1枚撮影 → そのままトリミングへ進む
  async function handleCameraShot(e, nextStep) {
    const file = e.target.files?.[0];
    if (!file) return;
    const img = await loadAndResizeImage(file);
    const groupId = activePhotoTab !== "all" && activePhotoTab !== "unsorted" ? activePhotoTab : null;
    const entry = onAddPhoto(img, groupId);
    setActivePhoto(entry);
    goTo(nextStep);
    e.target.value = "";
  }

  // 「アップロードする」: 複数枚まとめてライブラリに追加（トリミングはあとでライブラリから選んで行う）
  async function handleUploadFiles(e, groupId) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    for (const file of files) {
      const img = await loadAndResizeImage(file);
      onAddPhoto(img, groupId || null);
    }
    e.target.value = "";
  }

  function pickFromLibrary(photo, nextStep) {
    setActivePhoto(photo);
    goTo(nextStep);
  }

  function handleFrontCropped(dataUrl) {
    onTouchPhotoLastUsed(activePhoto?.id);
    setPendingCards((prev) => [
      ...prev,
      {
        id: uid(),
        frontType: "image",
        frontSrc: dataUrl,
        frontText: null,
        frontSourcePhotoId: activePhoto?.id || null,
        backType: null,
        backSrc: null,
        backText: null,
        backSourcePhotoId: null,
      },
    ]);
    goTo("more-or-back");
  }

  function handleFrontText(text) {
    setPendingCards((prev) => [
      ...prev,
      {
        id: uid(),
        frontType: "text",
        frontSrc: null,
        frontText: text,
        frontSourcePhotoId: null,
        backType: null,
        backSrc: null,
        backText: null,
        backSourcePhotoId: null,
      },
    ]);
    goTo("more-or-back");
  }

  function handleBackCropped(dataUrl) {
    onTouchPhotoLastUsed(activePhoto?.id);
    setPendingCards((prev) =>
      prev.map((c, i) =>
        i === currentCardIdx
          ? { ...c, backType: "image", backSrc: dataUrl, backText: null, backSourcePhotoId: activePhoto?.id || null }
          : c
      )
    );
    goTo("more-or-back");
  }

  function handleBackText(text) {
    setPendingCards((prev) =>
      prev.map((c, i) =>
        i === currentCardIdx
          ? { ...c, backType: "text", backSrc: null, backText: text, backSourcePhotoId: null }
          : c
      )
    );
    goTo("more-or-back");
  }

  function handleBackSkip() {
    setPendingCards((prev) =>
      prev.map((c, i) => (i === currentCardIdx ? { ...c, backType: null, backSrc: null, backText: null } : c))
    );
    goTo("more-or-back");
  }

  return (
    <div style={styles.screen}>
      <header style={styles.headerRow}>
        <button style={styles.linkBtn} onClick={goBack}>
          ← {stepStack.length <= 1 ? "キャンセル" : "戻る"}
        </button>
        <div style={styles.eyebrow}>{addMode ? "カードを追加" : "新しいデッキ"}</div>
      </header>

      {(step === "upload-front" || step === "pick-front") && (
        <PhotoPicker
          title="① 問題文が写った写真を選ぶ"
          subtitle="基本は写真からの切り出しがおすすめです（指数や分数がきれいに残ります）"
          library={library}
          photoGroups={photoGroups}
          onPickLibrary={(p) => pickFromLibrary(p, "crop-front")}
          onCameraShot={(e) => handleCameraShot(e, "crop-front")}
          onUploadFiles={handleUploadFiles}
          onUseText={handleFrontText}
          onCreateGroup={onCreateGroup}
          onSetPhotoGroup={onSetPhotoGroup}
          onDeleteGroup={onDeleteGroup}
          onRenameGroup={onRenameGroup}
          sortOrder={librarySortOrder}
          onChangeSortOrder={onChangeSortOrder}
          onDeletePhoto={onDeletePhoto}
          activeTab={activePhotoTab}
          onChangeActiveTab={onChangeActivePhotoTab}
        />
      )}

      {step === "crop-front" && activePhoto && (
        <Cropper
          photo={activePhoto}
          instruction="問題文の範囲を四角で囲んでください"
          confirmLabel="この範囲を「表」にする"
          onConfirm={handleFrontCropped}
          onBackToPicker={goBack}
        />
      )}

      {(step === "upload-back" || step === "pick-back") && (
        <PhotoPicker
          title="② 答えが写った写真を選ぶ"
          subtitle="表と同じ写真でも、別の写真でもかまいません"
          library={library}
          photoGroups={photoGroups}
          onPickLibrary={(p) => pickFromLibrary(p, "crop-back")}
          onCameraShot={(e) => handleCameraShot(e, "crop-back")}
          onUploadFiles={handleUploadFiles}
          onUseText={handleBackText}
          onSkip={handleBackSkip}
          onCreateGroup={onCreateGroup}
          onSetPhotoGroup={onSetPhotoGroup}
          onDeleteGroup={onDeleteGroup}
          onRenameGroup={onRenameGroup}
          sortOrder={librarySortOrder}
          onChangeSortOrder={onChangeSortOrder}
          onDeletePhoto={onDeletePhoto}
          activeTab={activePhotoTab}
          onChangeActiveTab={onChangeActivePhotoTab}
        />
      )}

      {step === "crop-back" && activePhoto && (
        <Cropper
          photo={activePhoto}
          instruction="答えの範囲を四角で囲んでください"
          confirmLabel="この範囲を「裏」にする"
          onConfirm={handleBackCropped}
          onBackToPicker={goBack}
        />
      )}

      {step === "more-or-back" && (
        <div style={styles.confirmBox}>
          <p style={styles.sectionLabel}>作成中のカード（{pendingCards.length} 枚）</p>
          <div style={styles.pendingGrid}>
            {pendingCards.map((c, i) => (
              <div key={c.id} style={styles.pendingCard}>
                <CardThumb src={c.frontSrc} text={c.frontText} />
                {c.backType ? (
                  <div style={{ marginTop: 6 }}>
                    <CardThumb src={c.backSrc} text={c.backText} />
                  </div>
                ) : (
                  <div style={styles.pendingBadge}>答え未設定</div>
                )}
                <button
                  style={styles.tinyBtn}
                  onClick={() => {
                    setCurrentCardIdx(i);
                    goTo(library.length > 0 ? "pick-back" : "upload-back");
                  }}
                >
                  {c.backType ? "答えを変更" : "答えの範囲を選ぶ"}
                </button>
              </div>
            ))}
          </div>

          <div style={styles.rowButtons}>
            <button
              style={styles.secondaryBtn}
              onClick={() => goTo(library.length > 0 ? "pick-front" : "upload-front")}
            >
              ＋ もう1問切り出す
            </button>
          </div>

          {pendingCards.length > 0 && (
            <button style={styles.primaryBtn} onClick={() => goTo("name")}>
              次へ（{pendingCards.length}枚で確定）
            </button>
          )}
        </div>
      )}

      {step === "name" && (
        <div style={styles.confirmBox}>
          {!addMode && (
            <>
              <p style={styles.sectionLabel}>デッキの名前</p>
              <input
                style={styles.textInput}
                value={deckNameInput}
                placeholder="例：数学II 微分係数"
                onChange={(e) => setDeckNameInput(e.target.value)}
              />
            </>
          )}
          <button
            style={styles.primaryBtn}
            disabled={!addMode && !deckNameInput.trim()}
            onClick={() => {
              const newCards = pendingCards.map((c) => ({
                id: c.id,
                deckId: null,
                frontType: c.frontType,
                frontSrc: c.frontSrc,
                frontText: c.frontText,
                frontSourcePhotoId: c.frontSourcePhotoId || null,
                backType: c.backType,
                backSrc: c.backSrc,
                backText: c.backText,
                backSourcePhotoId: c.backSourcePhotoId || null,
                level: 0,
                seen: 0,
                correct: 0,
              }));
              onCreate(deckNameInput.trim() || "無題のデッキ", newCards);
            }}
          >
            {addMode ? "追加する" : "デッキを作成"}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- 写真ピッカー（ライブラリ選択・新規アップロード・テキスト入力・スキップ） ----------
function PhotoPicker({
  title,
  subtitle,
  library,
  photoGroups,
  onPickLibrary,
  onCameraShot,
  onUploadFiles,
  onUseText,
  onSkip,
  onCreateGroup,
  onSetPhotoGroup,
  onDeleteGroup,
  onRenameGroup,
  activeTab,
  onChangeActiveTab,
  sortOrder,
  onChangeSortOrder,
  onDeletePhoto,
}) {
  const cameraRef = useRef(null);
  const uploadRef = useRef(null);
  const [textMode, setTextMode] = useState(false);
  const [textValue, setTextValue] = useState("");
  const [uploading, setUploading] = useState(false);
  const [organizing, setOrganizing] = useState(false); // グループ整理モード
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [newGroupName, setNewGroupName] = useState("");
  const [showNewGroupInput, setShowNewGroupInput] = useState(false);
  const [groupManagerOpen, setGroupManagerOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [confirmDeleteGroupId, setConfirmDeleteGroupId] = useState(null);
  // sortOrder/onChangeSortOrder はpropsから受け取る（App本体で管理）

  // 番号はアップロード順（古い順）で固定。並び順を変えても番号がブレないようにする。
  const numbered = [...library]
    .sort((a, b) => a.addedAt - b.addedAt)
    .map((p, i) => ({ ...p, number: i + 1 }));

  // 表示順は「最近使った（アップロードした）順」「古い順」を切り替え可能。番号は上の固定値を使う。
  const displayList = [...numbered].sort((a, b) =>
    sortOrder === "newest" ? b.addedAt - a.addedAt : a.addedAt - b.addedAt
  );

  const visibleList = displayList.filter((p) => {
    if (activeTab === "all") return true;
    if (activeTab === "unsorted") return !p.groupId;
    return p.groupId === activeTab;
  });

  // 最近使った写真（lastUsedAt がある写真を使用日時の新しい順に最大5枚）
  const recentlyUsed = [...numbered]
    .filter((p) => !!p.lastUsedAt)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, 5);

  async function handleUploadChange(e) {
    setUploading(true);
    try {
      await onUploadFiles(e, activeTab !== "all" && activeTab !== "unsorted" ? activeTab : null);
    } finally {
      setUploading(false);
    }
  }

  function toggleSelect(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function assignSelectedToGroup(groupId) {
    selectedIds.forEach((id) => onSetPhotoGroup(id, groupId));
    setSelectedIds(new Set());
    setOrganizing(false);
  }

  function handleCreateGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    const id = onCreateGroup(name);
    setNewGroupName("");
    setShowNewGroupInput(false);
    if (selectedIds.size > 0) {
      assignSelectedToGroup(id);
    } else {
      onChangeActiveTab(id);
    }
  }

  function startEditGroupName(g) {
    setEditingGroupId(g.id);
    setEditingGroupName(g.name);
  }

  function saveEditGroupName() {
    const name = editingGroupName.trim();
    if (name && editingGroupId) {
      onRenameGroup(editingGroupId, name);
    }
    setEditingGroupId(null);
    setEditingGroupName("");
  }

  function confirmDeleteGroup() {
    if (!confirmDeleteGroupId) return;
    if (activeTab === confirmDeleteGroupId) onChangeActiveTab("all");
    onDeleteGroup(confirmDeleteGroupId);
    setConfirmDeleteGroupId(null);
  }

  if (textMode) {
    return (
      <div style={styles.confirmBox}>
        <p style={styles.sectionLabel}>{title}</p>
        <p style={styles.subText}>文字で入力します（指数や分数は読みにくくなる場合があります）</p>
        <textarea
          style={styles.textArea}
          value={textValue}
          placeholder="例：f(x) = x^3 - x^2 の導関数を求めよ"
          onChange={(e) => setTextValue(e.target.value)}
          autoFocus
        />
        <div style={styles.rowButtons}>
          <button style={styles.linkBtn} onClick={() => setTextMode(false)}>
            ← 写真に戻る
          </button>
          <button style={styles.primaryBtnFlex} disabled={!textValue.trim()} onClick={() => onUseText(textValue.trim())}>
            これで決定
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.confirmBox}>
      <p style={styles.sectionLabel}>{title}</p>
      {subtitle && <p style={styles.subText}>{subtitle}</p>}

      {/* 「撮る」: カメラを直接起動して1枚撮影 */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: "none" }}
        onChange={onCameraShot}
      />
      {/* 「アップロードする」: 端末の写真ライブラリから複数枚選択 */}
      <input
        ref={uploadRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={handleUploadChange}
      />

      <div style={styles.rowButtons}>
        <button style={styles.secondaryBtn} onClick={() => cameraRef.current?.click()}>
          📷 撮る
        </button>
        <button style={styles.primaryBtnFlex} disabled={uploading} onClick={() => uploadRef.current?.click()}>
          {uploading ? "読み込み中…" : "＋ アップロードする"}
        </button>
      </div>
      <p style={styles.helperTextSmall}>アップロードは複数枚まとめて選べます</p>

      {library.length > 0 && (
        <>
          <div style={styles.sectionDivider}>
            <span style={styles.sectionDividerLabel}>アップロード済みの写真から選ぶ（番号付き）</span>
            <span style={styles.dividerBtnGroup}>
              {photoGroups.length > 0 && (
                <button style={styles.organizeToggleBtn} onClick={() => setGroupManagerOpen((o) => !o)}>
                  グループを編集
                </button>
              )}
              <button
                style={styles.organizeToggleBtn}
                onClick={() => {
                  setOrganizing((o) => !o);
                  setSelectedIds(new Set());
                }}
              >
                {organizing ? "完了" : "整理する"}
              </button>
            </span>
          </div>

          {groupManagerOpen && (
            <div style={styles.groupManagerPanel}>
              <p style={styles.groupManagerTitle}>グループの編集</p>
              {photoGroups.length === 0 && <p style={styles.helperTextSmall}>まだグループがありません</p>}
              {photoGroups.map((g) => (
                <div key={g.id} style={styles.groupManagerRow}>
                  {editingGroupId === g.id ? (
                    <>
                      <input
                        style={styles.groupNewInput}
                        value={editingGroupName}
                        onChange={(e) => setEditingGroupName(e.target.value)}
                        autoFocus
                        onKeyDown={(e) => e.key === "Enter" && saveEditGroupName()}
                      />
                      <button style={styles.groupNewInputOk} disabled={!editingGroupName.trim()} onClick={saveEditGroupName}>
                        保存
                      </button>
                      <button style={styles.linkBtnMuted} onClick={() => setEditingGroupId(null)}>
                        やめる
                      </button>
                    </>
                  ) : (
                    <>
                      <span style={styles.groupManagerName}>
                        {g.name}（{library.filter((p) => p.groupId === g.id).length}枚）
                      </span>
                      <button style={styles.groupManagerEditBtn} onClick={() => startEditGroupName(g)}>
                        名前を変更
                      </button>
                      <button style={styles.groupManagerDeleteBtn} onClick={() => setConfirmDeleteGroupId(g.id)}>
                        削除
                      </button>
                    </>
                  )}
                </div>
              ))}

              {confirmDeleteGroupId && (
                <div style={styles.groupDeleteConfirmBox}>
                  <p style={styles.subText}>
                    「{photoGroups.find((g) => g.id === confirmDeleteGroupId)?.name}」を削除します。
                    中の写真は削除されず「未分類」に戻ります。
                  </p>
                  <div style={styles.rowButtons}>
                    <button style={styles.secondaryBtn} onClick={() => setConfirmDeleteGroupId(null)}>
                      やめる
                    </button>
                    <button style={styles.dangerBtn} onClick={confirmDeleteGroup}>
                      削除する
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* グループタブ */}
          <div style={styles.groupTabRow}>
            <button
              style={{ ...styles.groupTab, ...(activeTab === "all" ? styles.groupTabActive : {}) }}
              onClick={() => onChangeActiveTab("all")}
            >
              すべて（{library.length}）
            </button>
            <button
              style={{ ...styles.groupTab, ...(activeTab === "unsorted" ? styles.groupTabActive : {}) }}
              onClick={() => onChangeActiveTab("unsorted")}
            >
              未分類（{library.filter((p) => !p.groupId).length}）
            </button>
            {photoGroups.map((g) => (
              <button
                key={g.id}
                style={{ ...styles.groupTab, ...(activeTab === g.id ? styles.groupTabActive : {}) }}
                onClick={() => onChangeActiveTab(g.id)}
              >
                {g.name}（{library.filter((p) => p.groupId === g.id).length}）
              </button>
            ))}
            {!showNewGroupInput ? (
              <button style={styles.groupTabAdd} onClick={() => setShowNewGroupInput(true)}>
                ＋ グループ作成
              </button>
            ) : (
              <span style={styles.groupNewInputWrap}>
                <input
                  style={styles.groupNewInput}
                  value={newGroupName}
                  placeholder="例：問題文、答え"
                  onChange={(e) => setNewGroupName(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => e.key === "Enter" && handleCreateGroup()}
                />
                <button style={styles.groupNewInputOk} disabled={!newGroupName.trim()} onClick={handleCreateGroup}>
                  作成
                </button>
              </span>
            )}
          </div>

          {recentlyUsed.length > 0 && (
            <>
              <div style={styles.sectionDivider}>
                <span style={styles.sectionDividerLabel}>最近使った写真</span>
              </div>
              <div style={styles.libraryGrid}>
                {recentlyUsed.map((p) => (
                  <div
                    key={p.id}
                    style={styles.libraryThumb}
                    onClick={() => onPickLibrary(p)}
                  >
                    <img src={p.src} alt="" style={styles.libraryThumbImg} />
                    <span style={styles.libraryThumbNumber}>{p.number}</span>
                    <span style={styles.recentBadge}>最近</span>
                  </div>
                ))}
              </div>
            </>
          )}

          <div style={styles.sortRow}>
            <span style={styles.helperTextSmall}>並び順：</span>
            <button
              style={{ ...styles.sortBtn, ...(sortOrder === "newest" ? styles.sortBtnActive : {}) }}
              onClick={() => onChangeSortOrder("newest")}
            >
              新しい順
            </button>
            <button
              style={{ ...styles.sortBtn, ...(sortOrder === "oldest" ? styles.sortBtnActive : {}) }}
              onClick={() => onChangeSortOrder("oldest")}
            >
              古い順
            </button>
          </div>

          {organizing && (
            <p style={styles.helperTextSmall}>
              タップで選択（グループ割り当て）、長押しで削除（{selectedIds.size}枚選択中）
            </p>
          )}

          <div style={styles.libraryGrid}>
            {visibleList.map((p) => {
              const isSelected = selectedIds.has(p.id);
              return (
                <div
                  key={p.id}
                  style={{
                    ...styles.libraryThumb,
                    ...(organizing && isSelected ? styles.libraryThumbSelected : {}),
                  }}
                  onClick={() => (organizing ? toggleSelect(p.id) : onPickLibrary(p))}
                >
                  <img src={p.src} alt="" style={styles.libraryThumbImg} />
                  <span style={styles.libraryThumbNumber}>{p.number}</span>
                  {organizing ? (
                    <>
                      <span style={{ ...styles.libraryThumbCheck, ...(isSelected ? styles.libraryThumbCheckOn : {}) }}>
                        {isSelected ? "✓" : ""}
                      </span>
                      <button
                        style={styles.libraryThumbDeleteBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`写真 ${p.number} を削除しますか？\nこの操作は元に戻せません。`)) {
                            onDeletePhoto(p.id);
                          }
                        }}
                      >
                        🗑
                      </button>
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>

          {organizing && selectedIds.size > 0 && (
            <div style={styles.assignBar}>
              <span style={styles.assignBarLabel}>このグループに入れる：</span>
              <div style={styles.assignBarBtns}>
                <button style={styles.assignBarBtn} onClick={() => assignSelectedToGroup(null)}>
                  未分類に戻す
                </button>
                {photoGroups.map((g) => (
                  <button key={g.id} style={styles.assignBarBtn} onClick={() => assignSelectedToGroup(g.id)}>
                    {g.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <div style={styles.pickerAltRow}>
        {onUseText && (
          <button style={styles.linkBtn} onClick={() => setTextMode(true)}>
            文字で入力する
          </button>
        )}
        {onSkip && (
          <button style={styles.linkBtnMuted} onClick={onSkip}>
            あとで入力する（スキップ）
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- 矩形トリミングコンポーネント ----------
function Cropper({ photo, instruction, confirmLabel, onConfirm, onBackToPicker }) {
  const containerRef = useRef(null);
  const scrollWrapRef = useRef(null);
  const [rect, setRect] = useState(null);
  const [freePath, setFreePath] = useState(null); // フリーハンドモードの軌跡 [{x,y}, ...]
  const dragStartRef = useRef(null);
  const drawingRef = useRef(false);
  const panStartRef = useRef(null);
  const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 });
  const [shapeMode, setShapeMode] = useState("rect"); // "rect" | "free"（切り取りの形）
  const [interactionMode, setInteractionMode] = useState("draw"); // "draw"（範囲を選ぶ） | "move"（拡大して位置を動かす）
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    function measure() {
      if (containerRef.current) {
        const r = containerRef.current.getBoundingClientRect();
        // ズーム倍率を除いた「等倍時のサイズ」を基準に座標変換するため zoom で割って保持する
        setDisplaySize({ w: r.width / zoom, h: r.height / zoom });
      }
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [zoom]);

  function clampZoom(z) {
    return Math.min(4, Math.max(1, z));
  }

  function changeZoom(nextZoom) {
    setZoom(clampZoom(nextZoom));
    // 1倍に戻したら自動的に「範囲を選ぶ」操作に戻す（移動する必要がなくなるため）
    if (nextZoom <= 1) setInteractionMode("draw");
  }

  // interactionMode === "move" のときは1本指ドラッグで画像を動かす（スクロール）。
  // interactionMode === "draw" のときは1本指ドラッグで範囲（四角 or 自由形）を描く。
  // 2本指ジェスチャーは使わず、明示的なボタンでモードを切り替える方式にすることで、
  // タッチ操作の精度に左右されにくくしている。
  useEffect(() => {
    const el = containerRef.current;
    const wrap = scrollWrapRef.current;
    if (!el || !wrap) return;

    function getClientPos(e) {
      const touch = e.touches && e.touches[0];
      return { clientX: touch ? touch.clientX : e.clientX, clientY: touch ? touch.clientY : e.clientY };
    }

    function getPos(e) {
      const r = el.getBoundingClientRect();
      const { clientX, clientY } = getClientPos(e);
      // 表示座標を「zoom=1相当」の座標に正規化してから扱う
      return { x: (clientX - r.left) / zoom, y: (clientY - r.top) / zoom };
    }

    function handleDown(e) {
      if (e.touches && e.touches.length > 1) return;
      e.preventDefault();

      if (interactionMode === "move") {
        const { clientX, clientY } = getClientPos(e);
        panStartRef.current = { x: clientX, y: clientY, scrollLeft: wrap.scrollLeft, scrollTop: wrap.scrollTop };
        return;
      }

      const p = getPos(e);
      drawingRef.current = true;
      if (shapeMode === "rect") {
        dragStartRef.current = p;
        setRect({ x: p.x, y: p.y, w: 0, h: 0 });
      } else {
        setFreePath([p]);
      }
    }
    function handleMove(e) {
      if (e.touches && e.touches.length > 1) return;

      if (interactionMode === "move") {
        if (!panStartRef.current) return;
        e.preventDefault();
        const { clientX, clientY } = getClientPos(e);
        const dx = clientX - panStartRef.current.x;
        const dy = clientY - panStartRef.current.y;
        wrap.scrollLeft = panStartRef.current.scrollLeft - dx;
        wrap.scrollTop = panStartRef.current.scrollTop - dy;
        return;
      }

      if (!drawingRef.current) return;
      e.preventDefault();
      const p = getPos(e);
      if (shapeMode === "rect") {
        if (!dragStartRef.current) return;
        const start = dragStartRef.current;
        const x = Math.min(start.x, p.x);
        const y = Math.min(start.y, p.y);
        const w = Math.abs(p.x - start.x);
        const h = Math.abs(p.y - start.y);
        setRect({ x, y, w, h });
      } else {
        setFreePath((prev) => (prev ? [...prev, p] : [p]));
      }
    }
    function handleUp(e) {
      if (e.cancelable) e.preventDefault();
      drawingRef.current = false;
      dragStartRef.current = null;
      panStartRef.current = null;
    }

    el.addEventListener("touchstart", handleDown, { passive: false });
    el.addEventListener("touchmove", handleMove, { passive: false });
    el.addEventListener("touchend", handleUp, { passive: false });
    el.addEventListener("touchcancel", handleUp, { passive: false });
    el.addEventListener("mousedown", handleDown);
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);

    return () => {
      el.removeEventListener("touchstart", handleDown);
      el.removeEventListener("touchmove", handleMove);
      el.removeEventListener("touchend", handleUp);
      el.removeEventListener("touchcancel", handleUp);
      el.removeEventListener("mousedown", handleDown);
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [shapeMode, interactionMode, zoom]);

  function switchShapeMode(next) {
    setShapeMode(next);
    setRect(null);
    setFreePath(null);
  }

  async function confirm() {
    const scaleX = photo.width / displaySize.w;
    const scaleY = photo.height / displaySize.h;

    if (shapeMode === "rect") {
      if (!rect || rect.w < 10 || rect.h < 10) return;
      const realRect = {
        x: rect.x * scaleX,
        y: rect.y * scaleY,
        w: rect.w * scaleX,
        h: rect.h * scaleY,
      };
      const cropped = await cropImage(photo.src, realRect);
      onConfirm(cropped);
      setRect(null);
    } else {
      if (!freePath || freePath.length < 3) return;
      const realPath = freePath.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY }));
      const cropped = await cropImageFreeform(photo.src, realPath);
      onConfirm(cropped);
      setFreePath(null);
    }
  }

  const hasSelection = shapeMode === "rect" ? !!rect && rect.w >= 10 : !!freePath && freePath.length >= 3;

  return (
    <div style={styles.cropperWrap}>
      <p style={styles.instruction}>{instruction}</p>

      <div style={styles.cropModeRow}>
        <button
          style={{ ...styles.cropModeBtn, ...(shapeMode === "rect" ? styles.cropModeBtnActive : {}) }}
          onClick={() => switchShapeMode("rect")}
        >
          ⬜ 四角で囲む
        </button>
        <button
          style={{ ...styles.cropModeBtn, ...(shapeMode === "free" ? styles.cropModeBtnActive : {}) }}
          onClick={() => switchShapeMode("free")}
        >
          ✏️ 自由に囲む
        </button>
        <div style={styles.zoomControls}>
          <button style={styles.zoomBtn} onClick={() => changeZoom(zoom - 0.5)} disabled={zoom <= 1}>
            −
          </button>
          <span style={styles.zoomLabel}>{Math.round(zoom * 100)}%</span>
          <button style={styles.zoomBtn} onClick={() => changeZoom(zoom + 0.5)} disabled={zoom >= 4}>
            ＋
          </button>
        </div>
      </div>

      {zoom > 1 && (
        <div style={styles.interactionToggleRow}>
          <button
            style={{ ...styles.interactionToggleBtn, ...(interactionMode === "move" ? styles.interactionToggleBtnActive : {}) }}
            onClick={() => setInteractionMode("move")}
          >
            ✋ 動かす
          </button>
          <button
            style={{ ...styles.interactionToggleBtn, ...(interactionMode === "draw" ? styles.interactionToggleBtnActive : {}) }}
            onClick={() => setInteractionMode("draw")}
          >
            ✂️ 範囲を選ぶ
          </button>
          <span style={styles.helperTextInline}>
            {interactionMode === "move" ? "ドラッグして見たい場所に動かせます" : "ドラッグして範囲を選んでください"}
          </span>
        </div>
      )}

      <div ref={scrollWrapRef} style={styles.cropperScrollWrap}>
        <div
          ref={containerRef}
          style={{
            ...styles.cropperImgWrap,
            width: `${zoom * 100}%`,
            touchAction: "none",
            cursor: interactionMode === "move" ? "grab" : "crosshair",
          }}
        >
          <img src={photo.src} alt="原本" style={styles.cropperImg} draggable={false} />
          {shapeMode === "rect" && rect && (
            <div
              style={{
                position: "absolute",
                left: rect.x * zoom,
                top: rect.y * zoom,
                width: rect.w * zoom,
                height: rect.h * zoom,
                border: "2px solid #B5482F",
                background: "rgba(181,72,47,0.10)",
                boxShadow: "0 0 0 9999px rgba(28,24,20,0.4)",
                pointerEvents: "none",
              }}
            />
          )}
          {shapeMode === "free" && freePath && freePath.length > 1 && (
            <svg style={styles.freeSvgOverlay} width="100%" height="100%">
              <polygon
                points={freePath.map((p) => `${p.x * zoom},${p.y * zoom}`).join(" ")}
                fill="rgba(181,72,47,0.18)"
                stroke="#B5482F"
                strokeWidth="2.5"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </div>
      </div>

      <div style={styles.rowButtons}>
        <button style={styles.linkBtn} onClick={onBackToPicker}>
          ← 別の写真を選ぶ
        </button>
        <button style={styles.primaryBtnFlex} disabled={!hasSelection} onClick={confirm}>
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

// ---------- デッキ詳細画面 ----------
function DeckScreen({ deck, cards, onBack, onAddMore, onStudy, onStudyStarred, onOpenCard, onToggleStar, onResetLevels, onRenameDeck, onDeleteDeck }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  if (!deck) return null;
  const weak = cards.filter((c) => c.level <= 1).length;
  const starred = cards.filter((c) => c.starred);

  function startEditName() {
    setNameInput(deck.name);
    setEditingName(true);
  }
  function commitName() {
    if (nameInput.trim()) onRenameDeck(nameInput.trim());
    setEditingName(false);
  }

  return (
    <div style={styles.screen}>
      <header style={styles.headerRow}>
        <button style={styles.linkBtn} onClick={onBack}>
          ← ホーム
        </button>
      </header>
      {editingName ? (
        <div style={styles.deckNameEditRow}>
          <input
            style={styles.deckNameInput}
            value={nameInput}
            autoFocus
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commitName(); if (e.key === "Escape") setEditingName(false); }}
          />
          <button style={styles.primaryBtnFlex} onClick={commitName}>保存</button>
          <button style={styles.secondaryBtn} onClick={() => setEditingName(false)}>戻す</button>
        </div>
      ) : (
        <div style={styles.deckNameRow}>
          <h1 style={{ ...styles.h1, margin: 0 }}>{deck.name}</h1>
          <button style={styles.editNameBtn} onClick={startEditName} title="名前を変更">✎</button>
        </div>
      )}
      <div style={styles.statsRow}>
        <StatPill label="カード" value={cards.length} />
        <StatPill label="苦手" value={weak} accent onClick={weak > 0 ? () => onStudy("weak-only") : undefined} />
        <StatPill label="★マーク" value={starred.length} star onClick={starred.length > 0 ? () => onStudyStarred(starred.map((c) => c.id)) : undefined} />
      </div>

      <div style={styles.studyAllRow}>
        <button style={styles.primaryBtnFlex} disabled={weak === 0} onClick={() => onStudy("weak-only")}>
          苦手だけ復習（{weak}）
        </button>
        <button style={styles.secondaryBtn} disabled={cards.length === 0} onClick={() => onStudy("random")}>
          ランダムで復習
        </button>
      </div>

      {starred.length > 0 && (
        <button style={styles.starCtaSmall} onClick={() => onStudyStarred(starred.map((c) => c.id))}>
          ★ マークした {starred.length} 枚だけ復習
        </button>
      )}

      <button style={styles.secondaryBtnFull} onClick={onAddMore}>
        ＋ このデッキに写真を追加
      </button>

      <div style={styles.sectionDivider}>
        <span style={styles.sectionDividerLabel}>カード一覧（タップで編集）</span>
      </div>

      {cards.length === 0 ? (
        <p style={styles.emptyText}>まだカードがありません。写真を追加してください。</p>
      ) : (
        <div style={styles.pendingGrid}>
          {cards.map((c) => (
            <div key={c.id} style={styles.pendingCardClickable} onClick={() => onOpenCard(c.id)}>
              <div style={styles.cardThumbHeader}>
                <LevelBar level={c.level} />
                <button
                  style={{ ...styles.starBadge, color: c.starred ? "#C28A35" : "#D0C8B0" }}
                  onClick={(e) => { e.stopPropagation(); onToggleStar(c.id); }}
                >★</button>
              </div>
              <CardThumb src={c.frontSrc} text={c.frontText} />
            </div>
          ))}
        </div>
      )}

      <div style={styles.dangerZone}>
        {/* 苦手リセット */}
        {weak > 0 && !confirmingDelete && (
          <div style={{ marginBottom: 14 }}>
            {!confirmingReset ? (
              <button style={styles.dangerLinkBtn} onClick={() => setConfirmingReset(true)}>
                このデッキの苦手をリセットして最初からやり直す
              </button>
            ) : (
              <div style={styles.dangerConfirmBox}>
                <p style={styles.subText}>「{deck.name}」の全カードの苦手度・出題回数をリセットします。カード自体は削除されません。</p>
                <div style={styles.rowButtons}>
                  <button style={styles.secondaryBtn} onClick={() => setConfirmingReset(false)}>やめる</button>
                  <button style={styles.dangerBtn} onClick={() => { onResetLevels(cards.map((c) => c.id)); setConfirmingReset(false); }}>
                    リセットする
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* デッキ削除 */}
        {!confirmingReset && (
          <>
            {!confirmingDelete ? (
              <button style={styles.dangerLinkBtn} onClick={() => setConfirmingDelete(true)}>
                このデッキを削除する
              </button>
            ) : (
              <div style={styles.dangerConfirmBox}>
                <p style={styles.subText}>「{deck.name}」とその中のカード {cards.length} 枚をすべて削除します。元に戻せません。</p>
                <div style={styles.rowButtons}>
                  <button style={styles.secondaryBtn} onClick={() => setConfirmingDelete(false)}>
                    やめる
                  </button>
                  <button style={styles.dangerBtn} onClick={onDeleteDeck}>
                    削除する
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// カード表面の小さなプレビュー：画像でもテキストでも対応
function CardThumb({ src, text }) {
  if (src) return <img src={src} alt="表" style={styles.pendingImg} />;
  return (
    <div style={styles.textThumb}>
      <span style={styles.textThumbContent}>{text || "（内容未設定）"}</span>
    </div>
  );
}

// ---------- カード編集画面 ----------
function EditCardScreen({
  card,
  library,
  onAddPhoto,
  onBack,
  onUpdate,
  onToggleStar,
  onDelete,
  photoGroups = [],
  onCreateGroup,
  onSetPhotoGroup,
  onDeleteGroup,
  onRenameGroup,
  activePhotoTab,
  onChangeActivePhotoTab,
  onTouchPhotoLastUsed,
  onDeletePhoto,
  librarySortOrder = "newest",
  onChangeSortOrder,
}) {
  // null: 表示モード, "front"/"back": その面を編集中
  const [editingSide, setEditingSide] = useState(null);
  const [editSubStep, setEditSubStep] = useState("pick"); // pick | crop
  const [activePhoto, setActivePhoto] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showSourcePhoto, setShowSourcePhoto] = useState(null); // 表示中の元写真 {src, label} | null

  if (!card) return null;

  function startEdit(side) {
    setEditingSide(side);
    setEditSubStep("pick");
    setActivePhoto(null);
  }

  function applyImage(side, dataUrl) {
    onTouchPhotoLastUsed(activePhoto?.id);
    if (side === "front") {
      onUpdate({ frontType: "image", frontSrc: dataUrl, frontText: null, frontSourcePhotoId: activePhoto?.id || null });
    } else {
      onUpdate({ backType: "image", backSrc: dataUrl, backText: null, backSourcePhotoId: activePhoto?.id || null });
    }
    setEditingSide(null);
  }

  function applyText(side, text) {
    if (side === "front") {
      onUpdate({ frontType: "text", frontSrc: null, frontText: text, frontSourcePhotoId: null });
    } else {
      onUpdate({ backType: "text", backSrc: null, backText: text, backSourcePhotoId: null });
    }
    setEditingSide(null);
  }

  function clearBack() {
    onUpdate({ backType: null, backSrc: null, backText: null, backSourcePhotoId: null });
    setEditingSide(null);
  }

  // ----- 編集中の表示 -----
  if (editingSide) {
    const sideLabel = editingSide === "front" ? "問題文（表）" : "答え（裏）";
    return (
      <div style={styles.screen}>
        <header style={styles.headerRow}>
          <button style={styles.linkBtn} onClick={() => setEditingSide(null)}>
            ← 編集をやめる
          </button>
        </header>

        {editSubStep === "pick" && (
          <PhotoPicker
            title={`${sideLabel} の内容を選ぶ`}
            library={library}
            photoGroups={photoGroups}
            onPickLibrary={(p) => {
              setActivePhoto(p);
              setEditSubStep("crop");
            }}
            onCameraShot={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const img = await loadAndResizeImage(file);
              const groupId = activePhotoTab !== "all" && activePhotoTab !== "unsorted" ? activePhotoTab : null;
              const entry = onAddPhoto(img, groupId);
              setActivePhoto(entry);
              setEditSubStep("crop");
              e.target.value = "";
            }}
            onUploadFiles={async (e, groupId) => {
              const files = Array.from(e.target.files || []);
              if (files.length === 0) return;
              for (const file of files) {
                const img = await loadAndResizeImage(file);
                onAddPhoto(img, groupId || null);
              }
              e.target.value = "";
            }}
            onUseText={(text) => applyText(editingSide, text)}
            onSkip={editingSide === "back" ? clearBack : undefined}
            onCreateGroup={onCreateGroup}
            onSetPhotoGroup={onSetPhotoGroup}
            onDeleteGroup={onDeleteGroup}
          onRenameGroup={onRenameGroup}
          sortOrder={librarySortOrder}
          onChangeSortOrder={onChangeSortOrder}
          onDeletePhoto={onDeletePhoto}
            activeTab={activePhotoTab}
            onChangeActiveTab={onChangeActivePhotoTab}
          />
        )}

        {editSubStep === "crop" && activePhoto && (
          <Cropper
            photo={activePhoto}
            instruction={`${sideLabel} の範囲を四角で囲んでください`}
            confirmLabel="この内容に変更する"
            onConfirm={(dataUrl) => applyImage(editingSide, dataUrl)}
            onBackToPicker={() => setEditSubStep("pick")}
          />
        )}
      </div>
    );
  }

  // 元になった写真（履歴）を探す。ライブラリから消えている場合は見つからない
  const frontSourcePhoto = card.frontSourcePhotoId ? library.find((p) => p.id === card.frontSourcePhotoId) : null;
  const backSourcePhoto = card.backSourcePhotoId ? library.find((p) => p.id === card.backSourcePhotoId) : null;
  // ----- 通常の表示・編集導線 -----
  return (
    <div style={styles.screen}>
      <header style={styles.headerRow}>
        <button style={styles.linkBtn} onClick={onBack}>
          ← デッキに戻る
        </button>
      </header>
      <div style={styles.editCardTitleRow}>
        <h1 style={{ ...styles.h1, margin: 0 }}>カードを編集</h1>
        <button
          style={{ ...styles.starToggleBtn, color: card.starred ? "#C28A35" : "#C7BCA0" }}
          onClick={onToggleStar}
          title={card.starred ? "★マークを外す" : "★マークをつける"}
        >
          {card.starred ? "★" : "☆"}
        </button>
      </div>

      <p style={styles.sectionLabel}>問題文（表）</p>
      <div style={styles.editCardFace}>
        <CardThumb src={card.frontSrc} text={card.frontText} />
      </div>
      <div style={styles.rowButtons}>
        <button style={styles.secondaryBtn} onClick={() => startEdit("front")}>
          問題文を変更する
        </button>
        {frontSourcePhoto && (
          <button
            style={styles.secondaryBtn}
            onClick={() => setShowSourcePhoto({ src: frontSourcePhoto.src, label: "問題文（表）の元の写真" })}
          >
            元の写真を見る
          </button>
        )}
      </div>

      <p style={{ ...styles.sectionLabel, marginTop: 22 }}>答え（裏）</p>
      <div style={styles.editCardFace}>
        {card.backType ? (
          <CardThumb src={card.backSrc} text={card.backText} />
        ) : (
          <p style={styles.emptyText}>まだ答えが設定されていません</p>
        )}
      </div>
      <div style={styles.rowButtons}>
        <button style={styles.secondaryBtn} onClick={() => startEdit("back")}>
          {card.backType ? "答えを変更する" : "答えを追加する"}
        </button>
        {backSourcePhoto && (
          <button
            style={styles.secondaryBtn}
            onClick={() => setShowSourcePhoto({ src: backSourcePhoto.src, label: "答え（裏）の元の写真" })}
          >
            元の写真を見る
          </button>
        )}
      </div>

      {showSourcePhoto && (
        <div style={styles.confirmOverlay} onClick={() => setShowSourcePhoto(null)}>
          <div style={styles.sourcePhotoDialog} onClick={(e) => e.stopPropagation()}>
            <p style={styles.confirmTitle}>{showSourcePhoto.label}</p>
            <img src={showSourcePhoto.src} alt="元の写真" style={styles.sourcePhotoImg} />
            <button style={styles.primaryBtn} onClick={() => setShowSourcePhoto(null)}>
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* メモ欄 */}
      <p style={{ ...styles.sectionLabel, marginTop: 22 }}>メモ（ひとこと）</p>
      <textarea
        style={styles.memoArea}
        value={card.memo || ""}
        placeholder="この公式は微分で出る、など自由に書けます"
        onChange={(e) => onUpdate({ memo: e.target.value })}
      />

      <div style={{ ...styles.statsRow, marginTop: 22 }}>
        <StatPill label="出題回数" value={card.seen} />
        <StatPill label="正解数" value={card.correct} />
      </div>

      <div style={styles.dangerZone}>
        {!confirmingDelete ? (
          <button style={styles.dangerLinkBtn} onClick={() => setConfirmingDelete(true)}>
            このカードを削除する
          </button>
        ) : (
          <div style={styles.dangerConfirmBox}>
            <p style={styles.subText}>このカードを削除します。元に戻せません。</p>
            <div style={styles.rowButtons}>
              <button style={styles.secondaryBtn} onClick={() => setConfirmingDelete(false)}>
                やめる
              </button>
              <button style={styles.dangerBtn} onClick={onDelete}>
                削除する
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function LevelBar({ level }) {
  return (
    <div style={styles.levelBar}>
      {Array.from({ length: LEVELS }).map((_, i) => (
        <div
          key={i}
          style={{
            ...styles.levelDot,
            background: i <= level ? levelColor(level) : "#E3DACB",
          }}
        />
      ))}
    </div>
  );
}

function levelColor(level) {
  if (level <= 1) return "#B5482F";
  if (level === 2) return "#C28A35";
  return "#3C6E54";
}

// 学習画面でのカード面表示：画像でもテキストでも対応
function StudyFace({ type, src, text }) {
  if (type === "text") {
    return (
      <div style={styles.studyTextFace}>
        <p style={styles.studyTextContent}>{text}</p>
      </div>
    );
  }
  return <img src={src} alt="" style={styles.flipImg} />;
}

// ---------- 学習（フリップカード）画面 ----------
function StudyScreen({ cards, mode, onResult, onToggleStar, onExit }) {
  // initialized: useEffectでqueueが確定したか
  const [initialized, setInitialized] = useState(false);
  const [queue, setQueue] = useState([]);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [done, setDone] = useState(false);
  const [resultLog, setResultLog] = useState([]); // [{cardId, known}]

  // マウント時に1回だけ出題順を確定する。
  // cards は親の state から毎レンダー新しい参照が来るため依存配列に含めない。
  useEffect(() => {
    let pool = [...cards];
    if (mode === "weak-only") {
      pool = pool.filter((c) => c.level <= 1);
    } else if (mode === "weak") {
      pool.sort((a, b) => a.level - b.level);
    }
    pool.sort(() => Math.random() - 0.5);
    setQueue(pool);
    setIdx(0);
    setFlipped(false);
    setDone(false);
    setResultLog([]);
    setInitialized(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- 初期化前：ローディング ---
  if (!initialized) {
    return (
      <div style={styles.screen}>
        <div style={styles.emptyState}>
          <div style={styles.emptyGlyph}>…</div>
        </div>
      </div>
    );
  }

  // --- 苦手なし（weak-onlyで対象0枚） ---
  if (mode === "weak-only" && queue.length === 0) {
    return (
      <div style={styles.screen}>
        <header style={styles.headerRow}>
          <button style={styles.linkBtn} onClick={onExit}>← 戻る</button>
        </header>
        <div style={styles.emptyState}>
          <div style={styles.emptyGlyph}>☺</div>
          <p style={styles.emptyText}>今のところ苦手なカードはありません</p>
          <button style={styles.primaryBtn} onClick={onExit}>戻る</button>
        </div>
      </div>
    );
  }

  // --- セッション終了：サマリー ---
  if (done) {
    const total = resultLog.length;
    const correctCount = resultLog.filter((r) => r.known).length;
    const wrongIds = new Set(resultLog.filter((r) => !r.known).map((r) => r.cardId));
    const wrongCards = queue.filter((c) => wrongIds.has(c.id));
    const pct = total > 0 ? Math.round((correctCount / total) * 100) : 0;

    return (
      <div style={styles.screen}>
        <header style={styles.headerRow}>
          <button style={styles.linkBtn} onClick={onExit}>← 戻る</button>
        </header>
        <h1 style={styles.h1}>セッション終了</h1>

        <div style={styles.summaryScoreRow}>
          <div style={{
            ...styles.summaryScoreCircle,
            background: `conic-gradient(#3C6E54 0% ${pct}%, #E3DACB ${pct}% 100%)`,
          }}>
            <span style={styles.summaryScorePct}>{pct}<span style={styles.summaryScorePctUnit}>%</span></span>
            <span style={styles.summaryScoreLabel}>正解率</span>
          </div>
          <div style={styles.summaryStats}>
            <div style={styles.summaryStatItem}>
              <span style={styles.summaryStatValue}>{total}</span>
              <span style={styles.summaryStatLabel}>出題</span>
            </div>
            <div style={styles.summaryStatDivider} />
            <div style={styles.summaryStatItem}>
              <span style={{ ...styles.summaryStatValue, color: "#3C6E54" }}>{correctCount}</span>
              <span style={styles.summaryStatLabel}>正解</span>
            </div>
            <div style={styles.summaryStatDivider} />
            <div style={styles.summaryStatItem}>
              <span style={{ ...styles.summaryStatValue, color: "#B5482F" }}>{total - correctCount}</span>
              <span style={styles.summaryStatLabel}>不正解</span>
            </div>
          </div>
        </div>

        {wrongCards.length > 0 && (
          <>
            <div style={styles.sectionDivider}>
              <span style={styles.sectionDividerLabel}>もう一度見直したいカード（{wrongCards.length}枚）</span>
            </div>
            <div style={styles.summaryWrongGrid}>
              {wrongCards.map((c) => (
                <div key={c.id} style={styles.summaryWrongCard}>
                  <CardThumb src={c.frontSrc} text={c.frontText} />
                  {c.memo && <p style={styles.summaryCardMemo}>📝 {c.memo}</p>}
                </div>
              ))}
            </div>
          </>
        )}

        <button style={{ ...styles.primaryBtn, marginTop: 24 }} onClick={onExit}>
          デッキに戻る
        </button>
      </div>
    );
  }

  // --- 通常のカード表示 ---
  // ここに来た時点で initialized=true, done=false, queue.length>0 が保証される
  const current = queue[idx];
  if (!current) {
    // 念のため（通常は到達しないはず）
    return (
      <div style={styles.screen}>
        <div style={styles.emptyState}>
          <p style={styles.emptyText}>カードが見つかりません</p>
          <button style={styles.primaryBtn} onClick={onExit}>戻る</button>
        </div>
      </div>
    );
  }

  const hasBack = !!current.backType;

  function next(known) {
    onResult(current.id, known);
    setResultLog((prev) => [...prev, { cardId: current.id, known }]);
    if (idx + 1 >= queue.length) {
      setDone(true);
    } else {
      setIdx(idx + 1);
      setFlipped(false);
    }
  }

  return (
    <div style={styles.screen}>
      <header style={styles.headerRow}>
        <button style={styles.linkBtn} onClick={onExit}>
          ← やめる
        </button>
        <div style={styles.progressText}>
          {idx + 1} / {queue.length}
        </div>
      </header>

      <div style={styles.progressTrack}>
        <div style={{ ...styles.progressFill, width: `${((idx + (flipped ? 1 : 0.4)) / queue.length) * 100}%` }} />
      </div>

      <div style={styles.studyArea}>
        <div style={styles.flipOuter} onClick={() => hasBack && setFlipped((f) => !f)}>
          <div
            style={{
              ...styles.flipInner,
              transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)",
            }}
          >
            <div style={styles.flipFace}>
              <span style={styles.faceLabel}>問題</span>
              <button
                style={{ ...styles.studyStarBtn, color: current.starred ? "#C28A35" : "#D0C8B0" }}
                onClick={(e) => { e.stopPropagation(); onToggleStar(current.id); }}
              >
                {current.starred ? "★" : "☆"}
              </button>
              <StudyFace type={current.frontType} src={current.frontSrc} text={current.frontText} />
              {hasBack ? (
                !flipped && <div style={styles.tapHint}>タップして答えを見る</div>
              ) : (
                <div style={styles.noBackTag}>答え未登録</div>
              )}
            </div>
            <div style={{ ...styles.flipFace, ...styles.flipFaceBack }}>
              <span style={styles.faceLabelBack}>答え</span>
              <button
                style={{ ...styles.studyStarBtn, color: current.starred ? "#C28A35" : "#D0C8B0" }}
                onClick={(e) => { e.stopPropagation(); onToggleStar(current.id); }}
              >
                {current.starred ? "★" : "☆"}
              </button>
              {hasBack && <StudyFace type={current.backType} src={current.backSrc} text={current.backText} />}
              {current.memo && (
                <div style={styles.studyMemoBox}>
                  <span style={styles.studyMemoIcon}>📝</span>
                  <span style={styles.studyMemoText}>{current.memo}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {(flipped || !hasBack) && (
          <div style={styles.resultRow}>
            <button style={styles.wrongBtn} onClick={() => next(false)}>
              わからなかった
            </button>
            <button style={styles.rightBtn} onClick={() => next(true)}>
              わかった
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- スタイル ----------
function GlobalStyles() {
  return (
    <style>{`
      * { box-sizing: border-box; }
      body { margin: 0; }
      button { font-family: inherit; cursor: pointer; transition: opacity .15s ease, transform .15s ease; }
      button:disabled { opacity: 0.38; cursor: not-allowed; }
      button:active:not(:disabled) { transform: scale(0.98); }
      input { font-family: inherit; }
      ::selection { background: #E8B7A8; }
    `}</style>
  );
}

const FONT_DISPLAY = "'Zen Old Mincho', 'Hiragino Mincho ProN', serif";
const FONT_BODY = "'Zen Maru Gothic', 'Hiragino Sans', sans-serif";

// ---- カラートークン ----
const INK = "#221F1A";        // 本文・見出し
const PAPER = "#EFE8D8";      // 背景（牛皮紙）
const CARD_BG = "#FBF8F0";    // カード面（白に近い紙）
const HAIRLINE = "#DCD2B8";   // 罫線
const MUTED = "#8B8270";      // 補助テキスト
const STAMP = "#B5482F";      // 朱の印（アクセント）
const STAMP_SOFT = "#F3DCD2"; // 朱の薄色
const GOLD = "#C28A35";       // 中間レベル
const GREEN = "#3C6E54";      // 得意・正解
const GREEN_SOFT = "#DEE9DF";
const RED_SOFT = "#F4DAD2";

const styles = {
  app: {
    fontFamily: FONT_BODY,
    background: PAPER,
    backgroundImage:
      "linear-gradient(180deg, rgba(255,255,255,0.25), rgba(255,255,255,0)), repeating-linear-gradient(0deg, rgba(34,31,26,0.018) 0px, rgba(34,31,26,0.018) 1px, transparent 1px, transparent 28px)",
    minHeight: "100vh",
    color: INK,
  },
  saveIndicator: {
    position: "fixed",
    top: 10,
    right: 14,
    maxWidth: 200,
    fontSize: 11,
    fontWeight: 700,
    color: MUTED,
    background: "rgba(251,248,240,0.95)",
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 14,
    padding: "5px 11px",
    zIndex: 50,
    letterSpacing: "0.02em",
    textAlign: "right",
  },
  saveIndicatorError: { color: STAMP, borderColor: "#E4B7A6" },
  saveIndicatorDetail: { fontSize: 10, fontWeight: 600, color: "#9A3A26", marginTop: 2, lineHeight: 1.4 },
  screen: {
    maxWidth: 480,
    margin: "0 auto",
    padding: "28px 20px 56px",
    minHeight: "100vh",
  },
  header: { marginBottom: 22 },
  headerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  eyebrow: {
    fontSize: 11,
    letterSpacing: "0.16em",
    color: STAMP,
    fontWeight: 700,
    textTransform: "uppercase",
  },
  subText: { fontSize: 13.5, color: MUTED, margin: "0 0 18px", lineHeight: 1.6 },
  helperTextSmall: { fontSize: 12, color: MUTED, margin: "2px 0 0", textAlign: "center" },
  h1: {
    fontFamily: FONT_DISPLAY,
    fontSize: 27,
    margin: "5px 0 16px",
    fontWeight: 700,
    letterSpacing: "0.01em",
  },
  emptyState: {
    textAlign: "center",
    padding: "64px 22px",
    background: CARD_BG,
    borderRadius: 16,
    border: `1px solid ${HAIRLINE}`,
  },
  emptyGlyph: {
    fontSize: 38,
    marginBottom: 16,
    color: STAMP,
    fontFamily: FONT_DISPLAY,
  },
  emptyText: { fontSize: 14.5, color: MUTED, marginBottom: 20, lineHeight: 1.7 },
  primaryBtn: {
    background: STAMP,
    color: "#FBF3EC",
    border: "none",
    borderRadius: 11,
    padding: "14px 22px",
    fontSize: 15,
    fontWeight: 700,
    width: "100%",
    boxShadow: "0 2px 0 rgba(0,0,0,0.06)",
  },
  primaryBtnFlex: {
    background: STAMP,
    color: "#FBF3EC",
    border: "none",
    borderRadius: 11,
    padding: "13px 18px",
    fontSize: 14.5,
    fontWeight: 700,
    flex: 1,
  },
  secondaryBtn: {
    background: CARD_BG,
    color: INK,
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 11,
    padding: "12px 16px",
    fontSize: 14,
    fontWeight: 600,
    flex: 1,
  },
  secondaryBtnFull: {
    background: CARD_BG,
    color: INK,
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 11,
    padding: "13px 16px",
    fontSize: 14,
    fontWeight: 600,
    width: "100%",
    marginBottom: 26,
  },
  linkBtn: {
    background: "none",
    border: "none",
    color: STAMP,
    fontSize: 14,
    fontWeight: 700,
    padding: 0,
  },
  statsRow: { display: "flex", gap: 10, marginBottom: 18 },
  statPill: {
    flex: 1,
    background: CARD_BG,
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 13,
    padding: "12px 16px",
  },
  statPillAccent: { borderColor: "#E4B7A6" },
  statPillClickable: { cursor: "pointer" },
  statValue: { fontFamily: FONT_DISPLAY, fontSize: 23, fontWeight: 700, lineHeight: 1.1 },
  statValueAccent: { color: STAMP },
  statLabel: { fontSize: 11, color: MUTED, marginTop: 3, letterSpacing: "0.04em" },

  weakCta: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    width: "100%",
    textAlign: "left",
    background: CARD_BG,
    border: `1.5px solid ${STAMP}`,
    borderRadius: 14,
    padding: "14px 18px",
    marginBottom: 12,
  },
  weakCtaGlyph: { fontSize: 13, color: STAMP },
  weakCtaTitle: { color: INK, fontWeight: 700, fontSize: 15 },
  weakCtaSub: { color: MUTED, fontSize: 12 },

  reviewCta: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    width: "100%",
    textAlign: "left",
    background: `linear-gradient(135deg, ${STAMP} 0%, #9A3A26 100%)`,
    border: "none",
    borderRadius: 14,
    padding: "16px 18px",
    marginBottom: 26,
    boxShadow: "0 3px 0 rgba(0,0,0,0.08)",
  },
  reviewCtaGlyph: { fontSize: 24, color: "#FBF3EC" },
  reviewCtaText: { display: "flex", flexDirection: "column", gap: 2 },
  reviewCtaTitle: { color: "#FBF3EC", fontWeight: 700, fontSize: 15.5 },
  reviewCtaSub: { color: "#F1D3C7", fontSize: 12 },

  sectionDivider: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    margin: "6px 0 14px",
  },
  sectionDividerLabel: {
    fontSize: 12,
    fontWeight: 700,
    color: MUTED,
    letterSpacing: "0.06em",
  },

  deckGrid: { display: "flex", flexDirection: "column", gap: 10 },
  deckCard: {
    display: "flex",
    alignItems: "center",
    background: CARD_BG,
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 13,
    overflow: "hidden",
  },
  deckCardSpine: { width: 5, alignSelf: "stretch", background: STAMP },
  deckCardBody: { flex: 1, padding: "15px 16px" },
  deckCardTitle: { fontWeight: 700, fontSize: 15.5, marginBottom: 4 },
  deckCardMeta: { fontSize: 12.5, color: MUTED },
  weakTag: { color: STAMP, fontWeight: 700 },
  deckCardArrow: { fontSize: 20, color: "#C7BCA0", paddingRight: 16 },
  deckCardAdd: {
    border: `1.5px dashed ${HAIRLINE}`,
    borderRadius: 13,
    padding: "16px 18px",
    textAlign: "center",
    color: STAMP,
    fontWeight: 700,
    fontSize: 14,
  },

  uploadBox: {
    textAlign: "center",
    padding: "64px 22px",
    background: CARD_BG,
    borderRadius: 16,
    border: `1px solid ${HAIRLINE}`,
  },

  libraryGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    gap: 8,
  },
  libraryThumb: {
    position: "relative",
    aspectRatio: "1 / 1",
    borderRadius: 10,
    overflow: "hidden",
    border: `1px solid ${HAIRLINE}`,
    background: CARD_BG,
  },
  libraryThumbSelected: { borderColor: STAMP, borderWidth: 2, boxShadow: "0 0 0 2px rgba(181,72,47,0.15)" },
  libraryThumbImg: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  libraryThumbNumber: {
    position: "absolute",
    top: 4,
    left: 4,
    minWidth: 18,
    height: 18,
    padding: "0 4px",
    borderRadius: 9,
    background: "rgba(28,24,20,0.62)",
    color: "#FBF3EC",
    fontSize: 10.5,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
  },
  libraryThumbCheck: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 18,
    height: 18,
    borderRadius: 9,
    background: "rgba(251,248,240,0.85)",
    border: `1.5px solid ${HAIRLINE}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 11,
    fontWeight: 700,
    color: STAMP,
  },
  libraryThumbCheckOn: { background: STAMP, borderColor: STAMP, color: "#FBF3EC" },
  recentBadge: {
    position: "absolute",
    bottom: 4,
    right: 4,
    background: "rgba(60,110,84,0.88)",
    color: "#FBF3EC",
    fontSize: 9,
    fontWeight: 700,
    borderRadius: 6,
    padding: "2px 5px",
    letterSpacing: "0.04em",
  },
  libraryThumbDeleteBtn: {
    position: "absolute",
    bottom: 4,
    left: 4,
    width: 24,
    height: 24,
    borderRadius: 8,
    background: "rgba(154,58,38,0.82)",
    border: "none",
    fontSize: 13,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    lineHeight: 1,
  },

  // 写真グループのタブ・整理UI
  dividerBtnGroup: { display: "flex", gap: 14, marginLeft: "auto" },
  organizeToggleBtn: {
    background: "none",
    border: "none",
    color: STAMP,
    fontSize: 12,
    fontWeight: 700,
    padding: 0,
  },
  groupManagerPanel: {
    background: CARD_BG,
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  groupManagerTitle: { fontSize: 12.5, fontWeight: 700, color: "#5A5347", margin: 0 },
  groupManagerRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    paddingBottom: 8,
    borderBottom: `1px solid ${HAIRLINE}`,
  },
  groupManagerName: { fontSize: 13, fontWeight: 600, color: INK, flex: 1, minWidth: 90 },
  groupManagerEditBtn: {
    background: PAPER,
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 8,
    padding: "5px 10px",
    fontSize: 11.5,
    fontWeight: 700,
    color: STAMP,
  },
  groupManagerDeleteBtn: {
    background: "none",
    border: "none",
    color: "#9A3A26",
    fontSize: 11.5,
    fontWeight: 700,
    padding: "5px 4px",
    textDecoration: "underline",
  },
  groupDeleteConfirmBox: {
    background: "#FCF1ED",
    border: "1px solid #E4B7A6",
    borderRadius: 10,
    padding: 12,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  groupTabRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 10,
  },
  groupTab: {
    background: CARD_BG,
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 999,
    padding: "5px 11px",
    fontSize: 11.5,
    fontWeight: 700,
    color: MUTED,
  },
  groupTabActive: { background: STAMP, borderColor: STAMP, color: "#FBF3EC" },
  groupTabWithDelete: { position: "relative", display: "inline-flex" },
  groupTabDeleteBtn: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 16,
    height: 16,
    borderRadius: 8,
    background: "#9A3A26",
    color: "#FBF3EC",
    border: "none",
    fontSize: 10,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    lineHeight: 1,
  },
  groupTabAdd: {
    background: "none",
    border: `1px dashed ${HAIRLINE}`,
    borderRadius: 999,
    padding: "5px 11px",
    fontSize: 11.5,
    fontWeight: 700,
    color: STAMP,
  },
  groupNewInputWrap: { display: "flex", gap: 6, alignItems: "center" },
  groupNewInput: {
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 999,
    padding: "5px 11px",
    fontSize: 11.5,
    background: CARD_BG,
    width: 110,
  },
  groupNewInputOk: {
    background: STAMP,
    color: "#FBF3EC",
    border: "none",
    borderRadius: 999,
    padding: "5px 11px",
    fontSize: 11.5,
    fontWeight: 700,
  },
  sortRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginBottom: 8,
  },
  sortBtn: {
    background: "none",
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 999,
    padding: "4px 10px",
    fontSize: 11,
    fontWeight: 700,
    color: MUTED,
  },
  sortBtnActive: { background: PAPER, borderColor: STAMP, color: STAMP },
  assignBar: {
    background: "#FCF4EE",
    border: "1px solid #E4B7A6",
    borderRadius: 12,
    padding: "10px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  assignBarLabel: { fontSize: 12, fontWeight: 700, color: "#9A3A26" },
  assignBarBtns: { display: "flex", flexWrap: "wrap", gap: 6 },
  assignBarBtn: {
    background: CARD_BG,
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 999,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 600,
    color: INK,
  },

  cropperWrap: { display: "flex", flexDirection: "column", gap: 14 },
  instruction: { fontSize: 14, color: "#5A5347", margin: 0, fontWeight: 600 },
  cropModeRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  cropModeBtn: {
    background: CARD_BG,
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 10,
    padding: "8px 12px",
    fontSize: 12.5,
    fontWeight: 700,
    color: MUTED,
  },
  cropModeBtnActive: { background: STAMP, borderColor: STAMP, color: "#FBF3EC" },
  zoomControls: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginLeft: "auto",
    background: CARD_BG,
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 10,
    padding: "4px 6px",
  },
  zoomBtn: {
    width: 26,
    height: 26,
    borderRadius: 7,
    border: "none",
    background: PAPER,
    color: STAMP,
    fontSize: 15,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
  },
  zoomLabel: { fontSize: 11.5, fontWeight: 700, color: MUTED, minWidth: 34, textAlign: "center" },
  interactionToggleRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    background: "#FCF4EE",
    border: "1px solid #E4B7A6",
    borderRadius: 10,
    padding: "8px 10px",
  },
  interactionToggleBtn: {
    background: CARD_BG,
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 8,
    padding: "6px 11px",
    fontSize: 12.5,
    fontWeight: 700,
    color: MUTED,
  },
  interactionToggleBtnActive: { background: STAMP, borderColor: STAMP, color: "#FBF3EC" },
  helperTextInline: { fontSize: 11.5, color: "#9A3A26", fontWeight: 600 },
  cropperScrollWrap: {
    position: "relative",
    width: "100%",
    maxHeight: "60vh",
    overflow: "auto",
    borderRadius: 12,
    border: `1px solid ${HAIRLINE}`,
    background: "#0000",
  },
  cropperImgWrap: {
    position: "relative",
    width: "100%",
    userSelect: "none",
    WebkitTouchCallout: "none",
  },
  cropperImg: { width: "100%", display: "block", userSelect: "none", WebkitTouchCallout: "none", WebkitUserSelect: "none" },
  freeSvgOverlay: { position: "absolute", inset: 0, pointerEvents: "none" },
  rowButtons: { display: "flex", gap: 10, alignItems: "center" },
  confirmBox: { display: "flex", flexDirection: "column", gap: 14 },
  sectionLabel: { fontSize: 13, fontWeight: 700, color: "#5A5347", margin: "8px 0 0" },
  pendingGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  pendingCard: {
    background: CARD_BG,
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 12,
    padding: 8,
    position: "relative",
  },
  pendingImg: { width: "100%", borderRadius: 8, display: "block", background: PAPER },
  pendingCard: {
    background: CARD_BG,
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 12,
    padding: 8,
    position: "relative",
  },
  pendingCardClickable: {
    background: CARD_BG,
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 12,
    padding: 8,
    position: "relative",
    cursor: "pointer",
  },
  pendingBadge: { fontSize: 11, color: MUTED, marginTop: 6, textAlign: "center" },
  tinyBtn: {
    marginTop: 6,
    width: "100%",
    background: PAPER,
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 8,
    fontSize: 12,
    padding: "6px 8px",
    fontWeight: 700,
    color: STAMP,
  },
  textInput: {
    width: "100%",
    padding: "13px 14px",
    borderRadius: 10,
    border: `1px solid ${HAIRLINE}`,
    fontSize: 15,
    background: CARD_BG,
  },
  textArea: {
    width: "100%",
    minHeight: 120,
    padding: "13px 14px",
    borderRadius: 10,
    border: `1px solid ${HAIRLINE}`,
    fontSize: 15,
    background: CARD_BG,
    fontFamily: FONT_BODY,
    resize: "vertical",
    lineHeight: 1.6,
  },

  // テキストカードのプレビュー（一覧・編集中）
  textThumb: {
    background: PAPER,
    border: `1px dashed ${HAIRLINE}`,
    borderRadius: 8,
    padding: "14px 10px",
    minHeight: 64,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  textThumbContent: { fontSize: 12.5, color: INK, textAlign: "center", lineHeight: 1.5, wordBreak: "break-word" },

  // 写真ピッカーの「テキストで入力」「スキップ」行
  pickerAltRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 4,
  },
  linkBtnMuted: {
    background: "none",
    border: "none",
    color: MUTED,
    fontSize: 13,
    fontWeight: 600,
    padding: 0,
  },

  // 学習画面でのテキスト面
  studyTextFace: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0 8px",
  },
  studyTextContent: {
    fontSize: 19,
    lineHeight: 1.8,
    textAlign: "center",
    color: INK,
    fontFamily: FONT_DISPLAY,
    whiteSpace: "pre-wrap",
  },

  // カード編集画面
  editCardFace: {
    background: CARD_BG,
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
  },

  // 削除など危険な操作
  dangerZone: { marginTop: 30, paddingTop: 18, borderTop: `1px solid ${HAIRLINE}` },
  dangerLinkBtn: {
    background: "none",
    border: "none",
    color: "#9A3A26",
    fontSize: 13,
    fontWeight: 600,
    padding: 0,
    textDecoration: "underline",
  },
  dangerConfirmBox: {
    background: "#FCF1ED",
    border: "1px solid #E4B7A6",
    borderRadius: 12,
    padding: 14,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  dangerBtn: {
    flex: 1,
    background: "#9A3A26",
    color: "#FBF3EC",
    border: "none",
    borderRadius: 11,
    padding: "13px 18px",
    fontSize: 14.5,
    fontWeight: 700,
  },

  // データの引っ越し（エクスポート/インポート）
  dataSection: { marginTop: 32 },
  shareMethodLabel: { fontSize: 13.5, fontWeight: 700, color: INK, margin: "0 0 4px" },
  dataMessageOk: { fontSize: 13, color: GREEN, fontWeight: 600, marginTop: 4 },
  dataMessageError: { fontSize: 13, color: STAMP, fontWeight: 600, marginTop: 4 },

  // デッキ名編集
  deckNameRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    margin: "5px 0 16px",
  },
  editNameBtn: {
    background: "none",
    border: "none",
    fontSize: 18,
    color: "#B5482F",
    padding: "0 4px",
    lineHeight: 1,
    opacity: 0.7,
  },
  deckNameEditRow: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    margin: "5px 0 16px",
  },
  deckNameInput: {
    flex: 1,
    padding: "10px 12px",
    borderRadius: 10,
    border: "1.5px solid #B5482F",
    fontSize: 17,
    fontWeight: 700,
    background: "#FBF8F0",
    fontFamily: "'Zen Old Mincho', 'Hiragino Mincho ProN', serif",
  },

  // メモ欄
  memoArea: {
    width: "100%",
    minHeight: 72,
    padding: "11px 13px",
    borderRadius: 10,
    border: "1px solid #DCD2B8",
    fontSize: 14,
    background: "#FBF8F0",
    fontFamily: "'Zen Maru Gothic', 'Hiragino Sans', sans-serif",
    resize: "vertical",
    lineHeight: 1.6,
    color: "#221F1A",
  },
  // 学習中のメモ表示
  studyMemoBox: {
    position: "absolute",
    bottom: 14,
    left: 16,
    right: 16,
    background: "#FFFEF5",
    border: "1px solid #E8D7A0",
    borderRadius: 8,
    padding: "7px 10px",
    display: "flex",
    gap: 6,
    alignItems: "flex-start",
  },
  studyMemoIcon: { fontSize: 13, flexShrink: 0 },
  studyMemoText: {
    fontSize: 12,
    color: "#5A5347",
    lineHeight: 1.5,
    wordBreak: "break-word",
  },

  // 振り返りサマリー
  summaryScoreRow: {
    display: "flex",
    alignItems: "center",
    gap: 20,
    background: "#FBF8F0",
    border: "1px solid #DCD2B8",
    borderRadius: 16,
    padding: "20px 22px",
    marginBottom: 20,
  },
  summaryScoreCircle: {
    width: 88,
    height: 88,
    borderRadius: "50%",
    background: "conic-gradient(#3C6E54 0%, #3C6E54 var(--pct, 0%), #E3DACB var(--pct, 0%))",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    boxShadow: "inset 0 0 0 12px #FBF8F0",
  },
  summaryScorePct: {
    fontFamily: "'Zen Old Mincho', 'Hiragino Mincho ProN', serif",
    fontSize: 24,
    fontWeight: 700,
    color: "#221F1A",
    lineHeight: 1,
  },
  summaryScorePctUnit: { fontSize: 13, fontWeight: 600 },
  summaryScoreLabel: { fontSize: 11, color: "#8B8270", marginTop: 3, fontWeight: 600, letterSpacing: "0.04em" },
  summaryStats: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-around",
  },
  summaryStatItem: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
  },
  summaryStatValue: {
    fontFamily: "'Zen Old Mincho', 'Hiragino Mincho ProN', serif",
    fontSize: 28,
    fontWeight: 700,
    lineHeight: 1,
    color: "#221F1A",
  },
  summaryStatLabel: { fontSize: 11, color: "#8B8270", fontWeight: 600, letterSpacing: "0.04em" },
  summaryStatDivider: { width: 1, height: 40, background: "#DCD2B8" },
  summaryWrongGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
    marginBottom: 8,
  },
  summaryWrongCard: {
    background: "#FBF8F0",
    border: "1px solid #DCD2B8",
    borderRadius: 12,
    padding: 8,
  },
  summaryCardMemo: {
    fontSize: 11,
    color: "#8B8270",
    margin: "6px 0 0",
    lineHeight: 1.4,
    wordBreak: "break-word",
  },

  // ★マーク関連
  starCta: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    width: "100%",
    textAlign: "left",
    background: "#FFFBEE",
    border: "1.5px solid #C28A35",
    borderRadius: 14,
    padding: "14px 18px",
    marginBottom: 12,
  },
  starCtaGlyph: { fontSize: 20, color: "#C28A35" },
  starCtaTitle: { color: INK, fontWeight: 700, fontSize: 15 },
  starCtaSub: { color: MUTED, fontSize: 12 },
  starCtaSmall: {
    width: "100%",
    background: "#FFFBEE",
    border: "1.5px solid #C28A35",
    borderRadius: 11,
    padding: "12px 16px",
    fontSize: 14,
    fontWeight: 700,
    color: "#8A6020",
    marginBottom: 12,
    textAlign: "left",
  },
  // DeckScreenのカード一覧ヘッダー（LevelBar + ★ボタン）
  cardThumbHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  starBadge: {
    background: "none",
    border: "none",
    fontSize: 16,
    padding: "0 2px",
    lineHeight: 1,
  },
  // StudyScreenの★ボタン
  studyStarBtn: {
    position: "absolute",
    top: 14,
    right: 16,
    background: "none",
    border: "none",
    fontSize: 22,
    padding: 0,
    lineHeight: 1,
    zIndex: 1,
  },
  // EditCardScreenのタイトル行
  editCardTitleRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    margin: "5px 0 16px",
  },
  starToggleBtn: {
    background: "none",
    border: "none",
    fontSize: 30,
    padding: 0,
    lineHeight: 1,
  },
  // HomeScreenの苦手リセットボタン行
  resetRow: { marginTop: 4, marginBottom: 4 },
  // StatPillの★用
  statPillStar: { borderColor: "#E8D7A0" },
  statValueStar: { color: "#C28A35" },
  backupWarning: {
    background: "#FCF1ED",
    border: "1px solid #E4B7A6",
    borderRadius: 14,
    padding: "14px 16px",
    marginBottom: 18,
  },
  backupWarningTitle: { fontSize: 14, fontWeight: 700, color: "#9A3A26", margin: "0 0 4px" },
  backupWarningText: { fontSize: 12.5, color: "#5A5347", margin: 0, lineHeight: 1.6 },
  confirmOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(28,24,20,0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    zIndex: 100,
  },
  confirmDialog: {
    background: CARD_BG,
    borderRadius: 16,
    padding: 20,
    maxWidth: 380,
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  confirmTitle: { fontWeight: 700, fontSize: 16, margin: 0 },
  sourcePhotoDialog: {
    background: CARD_BG,
    borderRadius: 16,
    padding: 16,
    maxWidth: 520,
    width: "100%",
    maxHeight: "85vh",
    overflow: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  sourcePhotoImg: { width: "100%", borderRadius: 10, display: "block", border: `1px solid ${HAIRLINE}` },

  levelBar: { display: "flex", gap: 3, marginTop: 7, justifyContent: "center" },
  levelDot: { width: 12, height: 4, borderRadius: 2 },

  // デッキ選択画面
  selectAllBtn: {
    background: "none",
    border: "none",
    color: STAMP,
    fontWeight: 700,
    fontSize: 13,
    padding: 0,
    marginBottom: 14,
    textAlign: "left",
    alignSelf: "flex-start",
  },
  pickerList: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 110 },
  pickerRow: {
    display: "flex",
    alignItems: "center",
    gap: 13,
    background: CARD_BG,
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 12,
    padding: "13px 14px",
  },
  pickerRowChecked: { borderColor: "#E4B7A6", background: "#FCF4EE" },
  checkbox: {
    width: 21,
    height: 21,
    borderRadius: 6,
    border: `1.5px solid ${HAIRLINE}`,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: CARD_BG,
  },
  checkboxChecked: { background: STAMP, borderColor: STAMP },
  checkboxMark: { color: "#FBF3EC", fontSize: 13, fontWeight: 700 },
  pickerRowBody: { flex: 1 },
  pickerRowTitle: { fontWeight: 700, fontSize: 14.5 },
  pickerRowMeta: { fontSize: 12, color: MUTED, marginTop: 2 },
  pickerFooter: {
    position: "fixed",
    bottom: 0,
    left: 0,
    right: 0,
    maxWidth: 480,
    margin: "0 auto",
    background: CARD_BG,
    borderTop: `1px solid ${HAIRLINE}`,
    padding: "14px 20px 22px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    boxShadow: "0 -4px 16px rgba(34,31,26,0.06)",
  },
  pickerFooterCount: { fontSize: 12.5, color: MUTED, fontWeight: 600, textAlign: "center" },

  studyAllRow: { display: "flex", gap: 10, marginBottom: 24 },

  progressTrack: { height: 4, background: HAIRLINE, borderRadius: 2, marginBottom: 18, overflow: "hidden" },
  progressFill: { height: "100%", background: STAMP, borderRadius: 2, transition: "width .3s ease" },
  studyArea: { display: "flex", flexDirection: "column", gap: 20, marginTop: 4 },
  progressText: { fontSize: 13, color: MUTED, fontWeight: 700 },

  flipOuter: { perspective: 1400, width: "100%", minHeight: 380, cursor: "pointer" },
  flipInner: {
    position: "relative",
    width: "100%",
    minHeight: 380,
    transition: "transform 0.5s cubic-bezier(.4,.2,.2,1)",
    transformStyle: "preserve-3d",
  },
  flipFace: {
    position: "absolute",
    inset: 0,
    backfaceVisibility: "hidden",
    background: CARD_BG,
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 18,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    boxShadow: "0 3px 14px rgba(34,31,26,0.08)",
  },
  flipFaceBack: { transform: "rotateY(180deg)", background: "#F8F1E6" },
  faceLabel: {
    position: "absolute",
    top: 14,
    left: 16,
    fontSize: 11,
    fontWeight: 700,
    color: MUTED,
    letterSpacing: "0.08em",
  },
  faceLabelBack: {
    position: "absolute",
    top: 14,
    left: 16,
    fontSize: 11,
    fontWeight: 700,
    color: STAMP,
    letterSpacing: "0.08em",
  },
  flipImg: { maxWidth: "100%", maxHeight: 310, objectFit: "contain", borderRadius: 6 },
  noBackTag: { position: "absolute", bottom: 14, fontSize: 11, color: "#B7AE9A" },
  tapHint: { position: "absolute", bottom: 14, fontSize: 12, color: STAMP, fontWeight: 700 },

  resultRow: { display: "flex", gap: 10 },
  wrongBtn: {
    flex: 1,
    background: RED_SOFT,
    color: "#9A3A26",
    border: "none",
    borderRadius: 12,
    padding: "15px 0",
    fontWeight: 700,
    fontSize: 15,
  },
  rightBtn: {
    flex: 1,
    background: GREEN_SOFT,
    color: GREEN,
    border: "none",
    borderRadius: 12,
    padding: "15px 0",
    fontWeight: 700,
    fontSize: 15,
  },
};
