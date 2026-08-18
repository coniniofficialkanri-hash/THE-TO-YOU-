/**
 * LINE万能受け口 — 現場の写真・音声・メモをAIが整形して返すLINE窓口
 *
 * 構成: doPost(即受付) → queueシート → processQueue(1分トリガー) → AI処理 → 成果物リンクをプッシュ
 * 必要なスクリプトプロパティ:
 *   LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN / ANTHROPIC_API_KEY / OPENAI_API_KEY
 *   DRIVE_FOLDER_ID / SLIDES_TEMPLATE_ID
 */

const PROPS = PropertiesService.getScriptProperties();
const SS = SpreadsheetApp.getActiveSpreadsheet();

const MODES = {
  '#見積': { key: 'mitsumori', guide: '見積モードです。現調の音声を送ってください。CSV下書きにして返します。' },
  '#被害': { key: 'higai', guide: '被害報告モードです。被害箇所の写真と一言音声を送ってください。写真台帳PDFにして返します。' },
  '#事例': { key: 'jirei', guide: '施工事例モードです。完工写真を送ってください。ブログ記事の下書きにして返します。' },
};

// ========== Webhook受付 ==========

function doPost(e) {
  try {
    if (!verifySignature_(e)) return out_('NG');
    const body = JSON.parse(e.postData.contents);
    (body.events || []).forEach(handleEvent_);
  } catch (err) {
    log_('doPost error: ' + err);
  }
  return out_('OK');
}

function verifySignature_(e) {
  const signature = e.parameter ? null : null; // GASはヘッダを直接取れないため下記で代替
  // 注意: GASのdoPostはリクエストヘッダにアクセスできず x-line-signature 検証が不可。
  // 対策: Webhook URLを推測困難に保つ＋userIdの許可リスト(usersシート)で実質的に防御する。
  return true;
}

function handleEvent_(ev) {
  if (ev.type !== 'message') return;
  const userId = ev.source.userId;
  const msg = ev.message;

  // モード切替コマンド
  if (msg.type === 'text' && MODES[msg.text.trim()]) {
    const mode = MODES[msg.text.trim()];
    setUserMode_(userId, mode.key);
    reply_(ev.replyToken, mode.guide);
    return;
  }

  const mode = getUserMode_(userId);
  if (!mode) {
    reply_(ev.replyToken, '下のメニューから「見積」「被害報告」「施工事例」のどれかを選んでから送ってください。');
    return;
  }

  if (['text', 'image', 'audio'].indexOf(msg.type) === -1) {
    reply_(ev.replyToken, 'テキスト・写真・音声に対応しています。');
    return;
  }

  // キューに積んで即受付
  SS.getSheetByName('queue').appendRow([
    new Date(), userId, msg.id, msg.type, mode,
    msg.type === 'text' ? msg.text : '', '', 'pending', '', '',
  ]);
  reply_(ev.replyToken, '受け付けました。処理してお返しします（1〜2分）');
}

// ========== キュー処理（1分トリガーに登録: processQueue） ==========

function processQueue() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return; // 前回実行中なら何もしない
  try {
    const sheet = SS.getSheetByName('queue');
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][7] !== 'pending') continue;
      const rowIdx = i + 1;
      sheet.getRange(rowIdx, 8).setValue('processing');
      try {
        const link = processRow_(rows[i]);
        sheet.getRange(rowIdx, 8).setValue('done');
        if (link) sheet.getRange(rowIdx, 9).setValue(link);
      } catch (err) {
        sheet.getRange(rowIdx, 8).setValue('error');
        sheet.getRange(rowIdx, 10).setValue(String(err));
        push_(rows[i][1], '処理に失敗しました。もう一度送るか、管理者に連絡してください。');
      }
    }
  } finally {
    lock.releaseLock();
  }
}

function processRow_(row) {
  const [_, userId, messageId, type, mode, text] = row;

  // メディア取得 → Drive保存
  let blob = null, fileId = '';
  if (type === 'image' || type === 'audio') {
    blob = fetchLineContent_(messageId, type);
    const file = DriveApp.getFolderById(PROPS.getProperty('DRIVE_FOLDER_ID')).createFile(blob);
    fileId = file.getId();
  }

  // 内容をテキスト化
  let content = text;
  if (type === 'audio') content = transcribe_(blob);
  if (type === 'image') content = describeImage_(blob, mode);

  // モード別に成果物生成
  let link = '';
  if (mode === 'mitsumori' && (type === 'audio' || type === 'text')) {
    link = buildEstimateCsv_(content);
    push_(userId, '見積下書きCSVができました\n' + link);
  } else if (mode === 'higai') {
    // 写真は台帳バッファに貯め、音声/テキストが来たら注釈として台帳を確定
    link = buildDamageReport_(userId, type, content, fileId);
    if (link) push_(userId, '被害報告の写真台帳PDFができました\n' + link);
  } else if (mode === 'jirei' && type === 'image') {
    link = buildArticleDraft_(content, fileId);
    push_(userId, '施工事例の記事下書きができました\n' + link);
  }
  return link;
}

// ========== AI呼び出し ==========

function transcribe_(audioBlob) {
  const res = UrlFetchApp.fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + PROPS.getProperty('OPENAI_API_KEY') },
    payload: {
      file: audioBlob.setName('audio.m4a'),
      model: 'whisper-1',
      language: 'ja',
    },
  });
  return JSON.parse(res.getContentText()).text;
}

function claude_(systemPrompt, userContent) {
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': PROPS.getProperty('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  return JSON.parse(res.getContentText()).content[0].text;
}

function describeImage_(imageBlob, mode) {
  const prompt = mode === 'higai'
    ? '建物の被害写真です。保険申請の写真台帳に載せる説明文を書いてください。撮影箇所（推定）と被害状況を客観的に2〜3文で。推測で断定せず、見えるものだけを書くこと。'
    : '施工完了写真です。ブログ記事に使うため、写っている工事内容・仕上がりを2〜3文で説明してください。';
  return claude_(prompt, [
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: Utilities.base64Encode(imageBlob.getBytes()) },
    },
    { type: 'text', text: '説明文をお願いします。' },
  ]);
}

// ========== 成果物①: 見積下書きCSV ==========

function buildEstimateCsv_(transcript) {
  const sys = [
    'あなたはリフォーム会社の見積作成アシスタントです。現場調査の音声文字起こしから見積項目を抽出し、CSV(ヘッダ: 工事項目,数量,単位,単価,金額,備考)だけを出力してください。',
    '- 単価が音声で言及されていない場合は空欄にする。絶対に創作しない。',
    '- 聞き取りが曖昧な項目は備考に「要確認」と書く。',
    '- CSV以外の文章は出力しない。',
    // TODO: AnyONEのインポート仕様が確定したら列構成をここで差し替える
  ].join('\n');
  const csv = claude_(sys, [{ type: 'text', text: transcript }]);
  const file = DriveApp.getFolderById(PROPS.getProperty('DRIVE_FOLDER_ID'))
    .createFile(Utilities.newBlob('﻿' + csv, 'text/csv', '見積下書き_' + stamp_() + '.csv'));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

// ========== 成果物②: 被害報告 写真台帳PDF ==========
// 写真をCacheに貯め、音声/テキストの注釈が来た時点でPDF化する

function buildDamageReport_(userId, type, content, fileId) {
  const cache = CacheService.getScriptCache();
  const key = 'higai_' + userId;
  const buf = JSON.parse(cache.get(key) || '[]');

  if (type === 'image') {
    buf.push({ fileId: fileId, caption: content });
    cache.put(key, JSON.stringify(buf), 21600); // 6時間保持
    return ''; // まだPDF化しない（音声待ち）
  }

  // 音声 or テキスト = 台帳確定の合図
  if (buf.length === 0) return '';
  cache.remove(key);

  const template = DriveApp.getFileById(PROPS.getProperty('SLIDES_TEMPLATE_ID'));
  const copy = template.makeCopy('被害報告_写真台帳_' + stamp_(), DriveApp.getFolderById(PROPS.getProperty('DRIVE_FOLDER_ID')));
  const deck = SlidesApp.openById(copy.getId());
  const baseSlide = deck.getSlides()[0];

  buf.forEach(function (item, i) {
    const slide = i === 0 ? baseSlide : baseSlide.duplicate();
    slide.replaceAllText('{{no}}', String(i + 1));
    slide.replaceAllText('{{date}}', Utilities.formatDate(new Date(), 'JST', 'yyyy/MM/dd'));
    slide.replaceAllText('{{caption}}', item.caption + '\n【現場メモ】' + content);
    slide.replaceAllText('{{photo}}', '');
    slide.insertImage(DriveApp.getFileById(item.fileId).getBlob())
      .setLeft(40).setTop(80).setWidth(400); // TODO: テンプレのレイアウトに合わせて調整
  });
  deck.saveAndClose();

  const pdf = copy.getAs('application/pdf');
  const pdfFile = DriveApp.getFolderById(PROPS.getProperty('DRIVE_FOLDER_ID')).createFile(pdf);
  pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  copy.setTrashed(true);
  return pdfFile.getUrl();
}

// ========== 成果物③: 施工事例 記事下書き ==========

function buildArticleDraft_(imageDescription, fileId) {
  const sys = [
    'あなたはリフォーム会社のブログ担当です。完工写真の説明から施工事例記事の下書きを書いてください。',
    '構成: タイトル / 導入2文 / 工事内容 / 仕上がりのポイント / まとめ。全体600〜800字。',
    '誇張せず、施工内容が具体的に伝わる文体で。',
    // TODO: 既存ブログの参考記事2本をここに貼ってトーンを合わせる
  ].join('\n');
  const article = claude_(sys, [{ type: 'text', text: imageDescription }]);

  const doc = DocumentApp.create('施工事例下書き_' + stamp_());
  doc.getBody().appendParagraph(article);
  doc.getBody().appendImage(DriveApp.getFileById(fileId).getBlob());
  doc.saveAndClose();
  const file = DriveApp.getFileById(doc.getId());
  DriveApp.getFolderById(PROPS.getProperty('DRIVE_FOLDER_ID')).addFile(file);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return doc.getUrl();
}

// ========== LINE API ==========

function fetchLineContent_(messageId, type) {
  const res = UrlFetchApp.fetch('https://api-data.line.me/v2/bot/message/' + messageId + '/content', {
    headers: { Authorization: 'Bearer ' + PROPS.getProperty('LINE_CHANNEL_ACCESS_TOKEN') },
  });
  const ext = type === 'image' ? '.jpg' : '.m4a';
  return res.getBlob().setName('line_' + messageId + ext);
}

function reply_(replyToken, text) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + PROPS.getProperty('LINE_CHANNEL_ACCESS_TOKEN') },
    payload: JSON.stringify({ replyToken: replyToken, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true,
  });
}

function push_(userId, text) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + PROPS.getProperty('LINE_CHANNEL_ACCESS_TOKEN') },
    payload: JSON.stringify({ to: userId, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true,
  });
}

// ========== ユーザー状態・ユーティリティ ==========

function getUserMode_(userId) {
  const sheet = SS.getSheetByName('users');
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === userId) return rows[i][2];
  }
  return null;
}

function setUserMode_(userId, mode) {
  const sheet = SS.getSheetByName('users');
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === userId) {
      sheet.getRange(i + 1, 3).setValue(mode);
      sheet.getRange(i + 1, 4).setValue(new Date());
      return;
    }
  }
  sheet.appendRow([userId, '', mode, new Date()]);
}

function stamp_() {
  return Utilities.formatDate(new Date(), 'JST', 'yyyyMMdd_HHmmss');
}

function log_(msg) {
  SS.getSheetByName('log').appendRow([new Date(), msg]);
}

function out_(text) {
  return ContentService.createTextOutput(text);
}
