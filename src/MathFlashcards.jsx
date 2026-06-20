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

async function saveMeta(decks, cards, photoLibrary, photoGroups) {
  // 画像本体(frontSrc/backSrc/src)は別キーに保存するため、メタには含めない
  const cardsMeta = cards.map(({ frontSrc, backSrc, ...rest }) => rest);
  const photosMeta = photoLibrary.map(({ src, ...rest }) => rest);
  const payload = { decks, cards: cardsMeta, photos: photosMeta, photoGroups };
  try {
    await storage.set(STORAGE_META_KEY, JSON.stringify(payload));
  } catch (e) {
    console.error("メタ情報の保存に失敗しました", e);
    throw e; // 呼び出し元に伝播させ、保存失敗がUIに正しく反映されるようにする
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

  const { decks = [], cards: cardsMeta = [], photos: photosMeta = [], photoGroups = [] } = meta;

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
  const [loading, setLoading] = useState(true);
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
        // 復元済みの画像はそのまま「保存済み」として記録し、無駄な再保存を防ぐ
        data.cards.forEach((c) => {
          if (c.frontSrc) savedImagesRef.current.set(`card-front:${c.id}`, c.frontSrc);
          if (c.backSrc) savedImagesRef.current.set(`card-back:${c.id}`, c.backSrc);
        });
        data.photoLibrary.forEach((p) => {
          if (p.src) savedImagesRef.current.set(`photo:${p.id}`, p.src);
        });
      }
      hasLoadedRef.current = true;
      setLoading(false);
    })();
  }, []);

  // decks/cards/photoLibrary/photoGroups の変化を検知して保存する（読み込み完了後のみ、デバウンス付き）
  useEffect(() => {
    if (!hasLoadedRef.current) return;
    setSaveState("saving");
    const timer = setTimeout(async () => {
      try {
        await saveMeta(
          decks,
          cards.map((c) => ({ ...c, backSrcExists: !!c.backSrc })),
          photoLibrary,
          photoGroups
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
  }, [decks, cards, photoLibrary, photoGroups]);

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

  function createDeck(name) {
    const id = uid();
    setDecks((d) => [...d, { id, name, cardIds: [] }]);
    return id;
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
          onCancel={() => setScreen("home")}
          onCreate={(name, newCards) => {
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
          onOpenCard={(cardId) => {
            setActiveCardId(cardId);
            setScreen("edit-card");
          }}
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
          onBack={() => setScreen("deck")}
          onUpdate={(patch) => updateCard(activeCardId, patch)}
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
          deckName={decks.find((d) => d.id === activeDeckId)?.name}
          onCancel={() => setScreen("deck")}
          onCreate={(_, newCards) => {
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
  onExport,
  onImport,
  showBackupWarning,
}) {
  const totalCards = cards.length;
  const weakCount = cards.filter((c) => c.level <= 1).length;

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

          {totalCards > 0 && (
            <button style={styles.reviewCta} onClick={onOpenReviewPicker}>
              <span style={styles.reviewCtaGlyph}>⟲</span>
              <span style={styles.reviewCtaText}>
                <span style={styles.reviewCtaTitle}>デッキを選んで総復習</span>
                <span style={styles.reviewCtaSub}>複数の単元をまとめて復習できます</span>
              </span>
            </button>
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

      <DataTransferSection onExport={onExport} onImport={onImport} hasData={decks.length > 0} />
    </div>
  );
}

// ---------- データの書き出し・読み込み（別デバイス・別ブラウザへの引っ越し用） ----------
function DataTransferSection({ onExport, onImport, hasData }) {
  const fileRef = useRef(null);
  const [confirming, setConfirming] = useState(false);
  const [pendingFile, setPendingFile] = useState(null);
  const [message, setMessage] = useState(null); // {type: 'ok'|'error', text}

  async function handleExport() {
    try {
      const json = await onExport();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const date = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `math-flashcards-${date}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMessage({ type: "ok", text: "書き出しました" });
    } catch (e) {
      console.error("書き出しに失敗しました", e);
      setMessage({ type: "error", text: `書き出しに失敗しました：${e.message || e}` });
    }
  }

  function handleFileSelected(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingFile(file);
    setConfirming(true);
    e.target.value = "";
  }

  async function confirmImport() {
    if (!pendingFile) return;
    const text = await pendingFile.text();
    const result = onImport(text);
    setConfirming(false);
    setPendingFile(null);
    setMessage(
      result.ok
        ? { type: "ok", text: "読み込みました" }
        : { type: "error", text: `読み込みに失敗しました：${result.error}` }
    );
  }

  return (
    <div style={styles.dataSection}>
      <div style={styles.sectionDivider}>
        <span style={styles.sectionDividerLabel}>データの引っ越し</span>
      </div>
      <p style={styles.subText}>
        別のデバイスやブラウザで続けたいときは、ここからファイルを書き出して、もう一方の画面で読み込んでください。
      </p>
      <div style={styles.rowButtons}>
        <button style={styles.secondaryBtn} disabled={!hasData} onClick={handleExport}>
          書き出す（保存用ファイル）
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          style={{ display: "none" }}
          onChange={handleFileSelected}
        />
        <button style={styles.secondaryBtn} onClick={() => fileRef.current?.click()}>
          読み込む
        </button>
      </div>

      {message && <p style={message.type === "error" ? styles.dataMessageError : styles.dataMessageOk}>{message.text}</p>}

      {confirming && (
        <div style={styles.confirmOverlay}>
          <div style={styles.confirmDialog}>
            <p style={styles.confirmTitle}>今のデータを置き換えますか？</p>
            <p style={styles.subText}>
              読み込むと、今このブラウザに保存されているデッキ・カードはすべて上書きされます。
            </p>
            <div style={styles.rowButtons}>
              <button
                style={styles.secondaryBtn}
                onClick={() => {
                  setConfirming(false);
                  setPendingFile(null);
                }}
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

function StatPill({ label, value, accent, onClick }) {
  return (
    <div
      style={{
        ...styles.statPill,
        ...(accent ? styles.statPillAccent : {}),
        ...(onClick ? styles.statPillClickable : {}),
      }}
      onClick={onClick}
    >
      <div style={{ ...styles.statValue, ...(accent && value > 0 ? styles.statValueAccent : {}) }}>{value}</div>
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
}) {
  // upload-or-pick(front/back) → crop(front/back) → more-or-back → name
  // step は履歴スタックとして保持し、「戻る」で1つ前のステップに戻れるようにする
  const [stepStack, setStepStack] = useState([library.length > 0 ? "pick-front" : "upload-front"]);
  const step = stepStack[stepStack.length - 1];
  const [activePhoto, setActivePhoto] = useState(null); // 現在トリミング対象の写真 {id, src, width, height}
  const [deckNameInput, setDeckNameInput] = useState(deckName || "");
  const [pendingCards, setPendingCards] = useState([]);
  const [currentCardIdx, setCurrentCardIdx] = useState(null); // 裏を設定する対象カードのindex

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
    const entry = onAddPhoto(img);
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
    setPendingCards((prev) => [
      ...prev,
      { id: uid(), frontType: "image", frontSrc: dataUrl, frontText: null, backType: null, backSrc: null, backText: null },
    ]);
    goTo("more-or-back");
  }

  function handleFrontText(text) {
    setPendingCards((prev) => [
      ...prev,
      { id: uid(), frontType: "text", frontSrc: null, frontText: text, backType: null, backSrc: null, backText: null },
    ]);
    goTo("more-or-back");
  }

  function handleBackCropped(dataUrl) {
    setPendingCards((prev) =>
      prev.map((c, i) => (i === currentCardIdx ? { ...c, backType: "image", backSrc: dataUrl, backText: null } : c))
    );
    goTo("more-or-back");
  }

  function handleBackText(text) {
    setPendingCards((prev) =>
      prev.map((c, i) => (i === currentCardIdx ? { ...c, backType: "text", backSrc: null, backText: text } : c))
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
                backType: c.backType,
                backSrc: c.backSrc,
                backText: c.backText,
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
}) {
  const cameraRef = useRef(null);
  const uploadRef = useRef(null);
  const [textMode, setTextMode] = useState(false);
  const [textValue, setTextValue] = useState("");
  const [uploading, setUploading] = useState(false);
  const [activeTab, setActiveTab] = useState("all"); // "all" | "unsorted" | groupId
  const [organizing, setOrganizing] = useState(false); // グループ整理モード
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [newGroupName, setNewGroupName] = useState("");
  const [showNewGroupInput, setShowNewGroupInput] = useState(false);

  // 番号はアップロード順（古い順）で固定。並び順を変えても番号がブレないようにする。
  const numbered = [...library]
    .sort((a, b) => a.addedAt - b.addedAt)
    .map((p, i) => ({ ...p, number: i + 1 }));
  const numberById = new Map(numbered.map((p) => [p.id, p.number]));

  // 表示用：最新が上に来るよう新しい順、ただし番号は上の固定値を使う
  const displayList = [...numbered].sort((a, b) => b.addedAt - a.addedAt);

  const visibleList = displayList.filter((p) => {
    if (activeTab === "all") return true;
    if (activeTab === "unsorted") return !p.groupId;
    return p.groupId === activeTab;
  });

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
      setActiveTab(id);
    }
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
            <button
              style={styles.organizeToggleBtn}
              onClick={() => {
                setOrganizing((o) => !o);
                setSelectedIds(new Set());
              }}
            >
              {organizing ? "完了" : "整理する"}
            </button>
          </div>

          {/* グループタブ */}
          <div style={styles.groupTabRow}>
            <button
              style={{ ...styles.groupTab, ...(activeTab === "all" ? styles.groupTabActive : {}) }}
              onClick={() => setActiveTab("all")}
            >
              すべて（{library.length}）
            </button>
            <button
              style={{ ...styles.groupTab, ...(activeTab === "unsorted" ? styles.groupTabActive : {}) }}
              onClick={() => setActiveTab("unsorted")}
            >
              未分類（{library.filter((p) => !p.groupId).length}）
            </button>
            {photoGroups.map((g) => (
              <span key={g.id} style={styles.groupTabWithDelete}>
                <button
                  style={{ ...styles.groupTab, ...(activeTab === g.id ? styles.groupTabActive : {}) }}
                  onClick={() => setActiveTab(g.id)}
                >
                  {g.name}（{library.filter((p) => p.groupId === g.id).length}）
                </button>
                {organizing && onDeleteGroup && (
                  <button
                    style={styles.groupTabDeleteBtn}
                    onClick={() => {
                      if (activeTab === g.id) setActiveTab("all");
                      onDeleteGroup(g.id);
                    }}
                    title="グループを削除（写真は未分類に戻ります）"
                  >
                    ×
                  </button>
                )}
              </span>
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

          {organizing && (
            <p style={styles.helperTextSmall}>
              写真をタップして選び、下のグループに割り当ててください（{selectedIds.size}枚選択中）
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
                  {organizing && (
                    <span style={{ ...styles.libraryThumbCheck, ...(isSelected ? styles.libraryThumbCheckOn : {}) }}>
                      {isSelected ? "✓" : ""}
                    </span>
                  )}
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
  const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 });
  const [mode, setMode] = useState("rect"); // "rect" | "free"
  const [zoom, setZoom] = useState(1);
  const pinchStateRef = useRef(null); // ピンチズーム用の初期距離・倍率

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
  }

  // ピンチズーム＆2本指パン。1本指は範囲選択用ドラッグに専有させるため、
  // 「写真の位置を動かす」操作は2本指ジェスチャーに割り当てる
  // （一般的な画像編集アプリのピンチ操作に近い感覚）。
  useEffect(() => {
    const wrap = scrollWrapRef.current;
    if (!wrap) return;

    function distanceOf(touches) {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }
    function centerOf(touches) {
      return {
        x: (touches[0].clientX + touches[1].clientX) / 2,
        y: (touches[0].clientY + touches[1].clientY) / 2,
      };
    }

    function handleTouchStart(e) {
      if (e.touches.length === 2) {
        pinchStateRef.current = {
          startDist: distanceOf(e.touches),
          startZoom: zoom,
          startCenter: centerOf(e.touches),
          startScrollLeft: wrap.scrollLeft,
          startScrollTop: wrap.scrollTop,
        };
      }
    }
    function handleTouchMove(e) {
      if (e.touches.length === 2 && pinchStateRef.current) {
        e.preventDefault();
        const { startDist, startZoom, startCenter, startScrollLeft, startScrollTop } = pinchStateRef.current;
        const dist = distanceOf(e.touches);
        const scale = dist / startDist;
        changeZoom(startZoom * scale);

        const center = centerOf(e.touches);
        wrap.scrollLeft = startScrollLeft - (center.x - startCenter.x);
        wrap.scrollTop = startScrollTop - (center.y - startCenter.y);
      }
    }
    function handleTouchEnd(e) {
      if (e.touches.length < 2) pinchStateRef.current = null;
    }

    wrap.addEventListener("touchstart", handleTouchStart, { passive: false });
    wrap.addEventListener("touchmove", handleTouchMove, { passive: false });
    wrap.addEventListener("touchend", handleTouchEnd);
    wrap.addEventListener("touchcancel", handleTouchEnd);
    return () => {
      wrap.removeEventListener("touchstart", handleTouchStart);
      wrap.removeEventListener("touchmove", handleTouchMove);
      wrap.removeEventListener("touchend", handleTouchEnd);
      wrap.removeEventListener("touchcancel", handleTouchEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  // ドラッグでの範囲選択中、iOS Safari等がページのスクロールや
  // 画像の長押しコンテキストメニュー（保存・コピー等）を発動させてしまい、
  // 選択範囲が大きく崩れることがある。React の合成タッチイベントは
  // ブラウザによって passive 指定され preventDefault が効かない場合があるため、
  // ネイティブの addEventListener で { passive: false } を明示して確実に止める。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function getPos(e) {
      const r = el.getBoundingClientRect();
      const touch = e.touches && e.touches[0];
      const clientX = touch ? touch.clientX : e.clientX;
      const clientY = touch ? touch.clientY : e.clientY;
      // 表示座標を「zoom=1相当」の座標に正規化してから扱う
      return { x: (clientX - r.left) / zoom, y: (clientY - r.top) / zoom };
    }

    function handleDown(e) {
      if (e.touches && e.touches.length > 1) return; // 2本指はピンチズーム用なので範囲選択には使わない
      e.preventDefault();
      const p = getPos(e);
      drawingRef.current = true;
      if (mode === "rect") {
        dragStartRef.current = p;
        setRect({ x: p.x, y: p.y, w: 0, h: 0 });
      } else {
        setFreePath([p]);
      }
    }
    function handleMove(e) {
      if (!drawingRef.current) return;
      if (e.touches && e.touches.length > 1) return;
      e.preventDefault();
      const p = getPos(e);
      if (mode === "rect") {
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
  }, [mode, zoom]);

  function switchMode(nextMode) {
    setMode(nextMode);
    setRect(null);
    setFreePath(null);
  }

  async function confirm() {
    const scaleX = photo.width / displaySize.w;
    const scaleY = photo.height / displaySize.h;

    if (mode === "rect") {
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

  const hasSelection = mode === "rect" ? !!rect && rect.w >= 10 : !!freePath && freePath.length >= 3;

  return (
    <div style={styles.cropperWrap}>
      <p style={styles.instruction}>{instruction}</p>

      <div style={styles.cropModeRow}>
        <button
          style={{ ...styles.cropModeBtn, ...(mode === "rect" ? styles.cropModeBtnActive : {}) }}
          onClick={() => switchMode("rect")}
        >
          ⬜ 四角で囲む
        </button>
        <button
          style={{ ...styles.cropModeBtn, ...(mode === "free" ? styles.cropModeBtnActive : {}) }}
          onClick={() => switchMode("free")}
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
      {zoom > 1 && <p style={styles.helperTextSmall}>2本指で操作すると拡大したまま位置を動かせます（1本指は範囲選択用）</p>}

      <div ref={scrollWrapRef} style={styles.cropperScrollWrap}>
        <div
          ref={containerRef}
          style={{
            ...styles.cropperImgWrap,
            width: `${zoom * 100}%`,
            touchAction: "none",
          }}
        >
          <img src={photo.src} alt="原本" style={styles.cropperImg} draggable={false} />
          {mode === "rect" && rect && (
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
          {mode === "free" && freePath && freePath.length > 1 && (
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
function DeckScreen({ deck, cards, onBack, onAddMore, onStudy, onOpenCard, onDeleteDeck }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  if (!deck) return null;
  const weak = cards.filter((c) => c.level <= 1).length;
  return (
    <div style={styles.screen}>
      <header style={styles.headerRow}>
        <button style={styles.linkBtn} onClick={onBack}>
          ← ホーム
        </button>
      </header>
      <h1 style={styles.h1}>{deck.name}</h1>
      <div style={styles.statsRow}>
        <StatPill label="カード" value={cards.length} />
        <StatPill label="苦手" value={weak} accent onClick={weak > 0 ? () => onStudy("weak-only") : undefined} />
      </div>

      <div style={styles.studyAllRow}>
        <button style={styles.primaryBtnFlex} disabled={weak === 0} onClick={() => onStudy("weak-only")}>
          苦手だけ復習（{weak}）
        </button>
        <button style={styles.secondaryBtn} disabled={cards.length === 0} onClick={() => onStudy("random")}>
          ランダムで復習
        </button>
      </div>

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
              <CardThumb src={c.frontSrc} text={c.frontText} />
              <LevelBar level={c.level} />
            </div>
          ))}
        </div>
      )}

      <div style={styles.dangerZone}>
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
  onDelete,
  photoGroups = [],
  onCreateGroup,
  onSetPhotoGroup,
  onDeleteGroup,
}) {
  // null: 表示モード, "front"/"back": その面を編集中
  const [editingSide, setEditingSide] = useState(null);
  const [editSubStep, setEditSubStep] = useState("pick"); // pick | crop
  const [activePhoto, setActivePhoto] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  if (!card) return null;

  function startEdit(side) {
    setEditingSide(side);
    setEditSubStep("pick");
    setActivePhoto(null);
  }

  function applyImage(side, dataUrl) {
    if (side === "front") {
      onUpdate({ frontType: "image", frontSrc: dataUrl, frontText: null });
    } else {
      onUpdate({ backType: "image", backSrc: dataUrl, backText: null });
    }
    setEditingSide(null);
  }

  function applyText(side, text) {
    if (side === "front") {
      onUpdate({ frontType: "text", frontSrc: null, frontText: text });
    } else {
      onUpdate({ backType: "text", backSrc: null, backText: text });
    }
    setEditingSide(null);
  }

  function clearBack() {
    onUpdate({ backType: null, backSrc: null, backText: null });
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
              const entry = onAddPhoto(img);
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

  // ----- 通常の表示・編集導線 -----
  return (
    <div style={styles.screen}>
      <header style={styles.headerRow}>
        <button style={styles.linkBtn} onClick={onBack}>
          ← デッキに戻る
        </button>
      </header>
      <h1 style={styles.h1}>カードを編集</h1>

      <p style={styles.sectionLabel}>問題文（表）</p>
      <div style={styles.editCardFace}>
        <CardThumb src={card.frontSrc} text={card.frontText} />
      </div>
      <button style={styles.secondaryBtnFull} onClick={() => startEdit("front")}>
        問題文を変更する
      </button>

      <p style={styles.sectionLabel}>答え（裏）</p>
      <div style={styles.editCardFace}>
        {card.backType ? (
          <CardThumb src={card.backSrc} text={card.backText} />
        ) : (
          <p style={styles.emptyText}>まだ答えが設定されていません</p>
        )}
      </div>
      <button style={styles.secondaryBtnFull} onClick={() => startEdit("back")}>
        {card.backType ? "答えを変更する" : "答えを追加する"}
      </button>

      <div style={styles.statsRow}>
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
function StudyScreen({ cards, mode, onResult, onExit }) {
  const [queue, setQueue] = useState([]);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [done, setDone] = useState(false);

  // マウント時に1回だけ出題順を確定する。
  // cards は親コンポーネントの state からフィルタした新しい配列が
  // 毎レンダー渡されるため、依存配列に入れると回答ごとに再シャッフルされて
  // 「ボタンを押しても進まない（1問目に戻る）」事象が起きる。
  useEffect(() => {
    let pool = [...cards];
    if (mode === "weak-only") {
      // 苦手（レベル0,1）のカードだけに絞る
      pool = pool.filter((c) => c.level <= 1);
      pool.sort(() => Math.random() - 0.5);
    } else if (mode === "weak") {
      pool.sort((a, b) => a.level - b.level || Math.random() - 0.5);
    } else {
      pool.sort(() => Math.random() - 0.5);
    }
    setQueue(pool);
    setIdx(0);
    setFlipped(false);
    setDone(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = queue[idx];
  const hasBack = current && !!current.backType;

  function next(known) {
    if (current) onResult(current.id, known);
    if (idx + 1 >= queue.length) {
      setDone(true);
    } else {
      setIdx(idx + 1);
      setFlipped(false);
    }
  }

  const noWeakCards = mode === "weak-only" && queue.length === 0;

  if (done || !current) {
    return (
      <div style={styles.screen}>
        <div style={styles.emptyState}>
          <div style={styles.emptyGlyph}>{noWeakCards ? "☺" : "✓"}</div>
          <p style={styles.emptyText}>
            {noWeakCards ? "今のところ苦手なカードはありません" : "このセッションは終了です"}
          </p>
          <button style={styles.primaryBtn} onClick={onExit}>
            戻る
          </button>
        </div>
      </div>
    );
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
              <StudyFace type={current.frontType} src={current.frontSrc} text={current.frontText} />
              {hasBack ? (
                !flipped && <div style={styles.tapHint}>タップして答えを見る</div>
              ) : (
                <div style={styles.noBackTag}>答え未登録</div>
              )}
            </div>
            <div style={{ ...styles.flipFace, ...styles.flipFaceBack }}>
              <span style={styles.faceLabelBack}>答え</span>
              {hasBack && <StudyFace type={current.backType} src={current.backSrc} text={current.backText} />}
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

  // 写真グループのタブ・整理UI
  organizeToggleBtn: {
    background: "none",
    border: "none",
    color: STAMP,
    fontSize: 12,
    fontWeight: 700,
    padding: 0,
    marginLeft: "auto",
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
  dataMessageOk: { fontSize: 13, color: GREEN, fontWeight: 600, marginTop: 4 },
  dataMessageError: { fontSize: 13, color: STAMP, fontWeight: 600, marginTop: 4 },
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
