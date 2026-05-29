/// <reference types="@figma/plugin-typings" />
// ↑ 피그마 전용 명령어의 타입 정보를 불러오는 줄입니다. 지우지 마세요.

// ============================================================
// Banner Resizer — 플러그인의 "두뇌" 파일
// 3가지 기능:
//   1) 사이즈 생성 — 원본 프레임을 여러 광고 사이즈로 복제
//   2) 텍스트 동기화 — 원본 수정 시 자식 배너에 자동 전파
//   3) 포컬포인트 — 이미지의 중요 영역을 브러쉬로 칠해 저장하면,
//                  생성 시 그 영역이 중심에 오도록 자동 크롭
// ============================================================

const PRESET_SIZES: { id: string; label: string; w: number; h: number }[] = [
  { id: "s_1920x1080", label: "1920 × 1080", w: 1920, h: 1080 },
  { id: "s_780x780", label: "780 × 780", w: 780, h: 780 },
  { id: "s_600x600", label: "600 × 600", w: 600, h: 600 },
  { id: "s_700x240", label: "700 × 240", w: 700, h: 240 },
  { id: "s_720x1248", label: "720 × 1248", w: 720, h: 1248 },
  { id: "s_720x1080", label: "720 × 1080", w: 720, h: 1080 },
];

// ============================================================
// 사이즈별 텍스트·CTA 자동 스타일 (사용자 제공 사양)
//   - SIZE_STYLES 에 정의된 사이즈만 자동 적용
//   - 정의 없는 사이즈는 원본 그대로
//   - 필요한 레이어 이름: "Title", "Body", "CTA" (대소문자 일치)
// ============================================================
// 사이즈별 설정 — 지금은 "textbox" 레이어(그룹/프레임)의 위치만 관리.
// 텍스트 폰트·사이즈·정렬·CTA 박스 등 모든 스타일은 원본 디자인 그대로 유지.
interface SizeStyle {
  textboxPosition?: { x: number; y: number };
}

const SIZE_STYLES: { [sizeId: string]: SizeStyle } = {
  s_1920x1080: { textboxPosition: { x: 240, y: 390 } },
  // 다른 사이즈는 사용자 데이터 받는 대로 추가
};

const SOURCE_KEY = "bannerResizer.sourceFrameId"; // 자식 배너 → 원본 ID
const TEXT_ID_KEY = "bannerResizer.textId"; // 텍스트 → 안정 ID
const ROI_KEY_PREFIX = "bannerResizer.roi."; // 이미지 해시 → ROI(JSON), figma.root 에 저장

interface ROI {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface PluginMsg {
  type: string;
  selectedSizeIds?: string[];
  imageHash?: string;
  roi?: ROI;
}

figma.showUI(__html__, { width: 360, height: 620 });

// 선택이 바뀌면 두 탭의 상태(동기화·포컬)를 모두 갱신
figma.on("selectionchange", () => {
  postSelectionStatus();
  postImagesList();
});

figma.ui.onmessage = async (msg: PluginMsg) => {
  if (msg.type === "generate") {
    await generateBanners(msg.selectedSizeIds || []);
  } else if (msg.type === "sync") {
    await syncText();
  } else if (msg.type === "request-status") {
    postSelectionStatus();
  } else if (msg.type === "request-images") {
    postImagesList();
  } else if (msg.type === "request-image-bytes" && msg.imageHash) {
    await sendImageBytes(msg.imageHash);
  } else if (msg.type === "save-roi" && msg.imageHash && msg.roi) {
    saveROI(msg.imageHash, msg.roi);
    figma.notify("✅ 포컬포인트 저장됨");
    postImagesList();
  } else if (msg.type === "clear-roi" && msg.imageHash) {
    clearROI(msg.imageHash);
    figma.notify("⨯ 포컬포인트 삭제됨");
    postImagesList();
  } else if (msg.type === "cancel") {
    figma.closePlugin();
  }
};

// ============================================================
// 기능 1) 사이즈 생성
// ============================================================
async function generateBanners(selectedSizeIds: string[]): Promise<void> {
  const selection = figma.currentPage.selection;
  if (selection.length !== 1) {
    figma.notify("⚠️ 배너로 만들 프레임 1개를 먼저 선택해주세요.");
    return;
  }
  const source = selection[0];
  if (
    source.type !== "FRAME" &&
    source.type !== "COMPONENT" &&
    source.type !== "INSTANCE"
  ) {
    figma.notify("⚠️ 프레임(Frame)을 선택해주세요.");
    return;
  }
  const targets = PRESET_SIZES.filter(
    (s) => selectedSizeIds.indexOf(s.id) !== -1
  );
  if (targets.length === 0) {
    figma.notify("⚠️ 만들 사이즈를 최소 1개 이상 체크해주세요.");
    return;
  }

  ensureTextIds(source);

  const gap = 80;
  const startY = source.y + source.height + gap;
  let offsetX = source.x;
  const created: SceneNode[] = [];

  for (const target of targets) {
    const copy = source.clone();
    figma.currentPage.appendChild(copy);
    copy.name = target.label;

    // [cover 레이어 식별] — 리사이즈 전에 각 레이어의 메타 정보를 미리 캡쳐.
    //   origW/origH: 원래 크기 (포컬 없는 이미지는 그대로 유지하려고)
    //   isLeaf:      자기 자신이 직접 image fill 을 가진 leaf 인지
    //   hasFocal:    그 leaf 의 이미지에 포컬포인트가 저장돼 있는지
    const copyBox = copy.absoluteBoundingBox;
    interface CoverInfo {
      node: SceneNode;
      origW: number;
      origH: number;
      isLeaf: boolean;
      hasFocal: boolean;
    }
    const coverInfos: CoverInfo[] = [];
    const collectCovers = (node: SceneNode): void => {
      if (node !== copy && copyBox) {
        const lb = node.absoluteBoundingBox;
        // 레이어가 원본 프레임 영역을 "덮음" (정확히 일치 OR 더 커서 밖으로 삐져나옴) 인지 검사.
        // 이렇게 해야 원본 프레임 밖으로 여백이 삐져나와 있는 이미지 레이어도 cover 로 잡힘.
        if (
          lb &&
          lb.x <= copyBox.x + 1 &&
          lb.y <= copyBox.y + 1 &&
          lb.x + lb.width >= copyBox.x + copyBox.width - 1 &&
          lb.y + lb.height >= copyBox.y + copyBox.height - 1 &&
          containsImageFill(node)
        ) {
          const isLeaf = hasOwnImageFill(node);
          let hasFocal = false;
          if (isLeaf && "fills" in node && node.fills !== figma.mixed) {
            hasFocal = (node.fills as readonly Paint[]).some(
              (p) => p.type === "IMAGE" && !!p.imageHash && !!loadROI(p.imageHash)
            );
          }
          const ly = node as unknown as { width: number; height: number };
          coverInfos.push({
            node,
            origW: ly.width,
            origH: ly.height,
            isLeaf,
            hasFocal,
          });
        }
      }
      if ("children" in node) {
        for (const child of node.children) collectCovers(child);
      }
    };
    collectCovers(copy);

    copy.resize(target.w, target.h);
    copy.x = offsetX;
    copy.y = startY;
    copy.setPluginData(SOURCE_KEY, source.id);

    // [레이어 복원]
    //   ① 컨테이너 (image fill 없는 그룹/프레임): 새 프레임 크기로 강제
    //     → 안쪽 이미지가 보일 clip 영역을 확보
    //   ② 포컬 있는 이미지: 새 프레임 크기로 강제
    //     → applyROIsInNode 가 포컬 위치 중심으로 크롭 적용
    //   ③ 포컬 없는 이미지: 원본 크기 유지, 새 프레임 중앙에 배치
    //     → frame 의 clipsContent 가 보이는 부분만 잘라줌
    //     → 디자이너님이 나중에 드래그로 위치 자유롭게 조정 가능
    for (const info of coverInfos) {
      const ly = info.node as unknown as {
        x: number;
        y: number;
        resize: (w: number, h: number) => void;
      };
      if (info.isLeaf) {
        // 이미지 레이어 — 포컬 유무 상관없이 원본 비율 유지한 채 cover scale.
        //   scale = max(target.w/origW, target.h/origH)
        //   레이어 비율 = 이미지 비율 → image fill (FILL 모드) 이라 절대 안 찌그러짐.
        const scale = Math.max(target.w / info.origW, target.h / info.origH);
        const newW = info.origW * scale;
        const newH = info.origH * scale;
        if (typeof ly.resize === "function") {
          ly.resize(newW, newH);
        }

        // 위치 결정:
        //   - 포컬 있음: focal 중심이 target 중앙에 오도록 (layer 가 cover 유지하게 clamp)
        //   - 포컬 없음: 중앙 배치
        let focal: { x: number; y: number } | null = null;
        if (info.hasFocal && "fills" in info.node && info.node.fills !== figma.mixed) {
          for (const paint of info.node.fills as readonly Paint[]) {
            if (paint.type === "IMAGE" && paint.imageHash) {
              const roi = loadROI(paint.imageHash);
              if (roi) {
                focal = { x: roi.x + roi.w / 2, y: roi.y + roi.h / 2 };
                break;
              }
            }
          }
        }
        if (focal) {
          let posX = target.w / 2 - focal.x * newW;
          let posY = target.h / 2 - focal.y * newH;
          // layer 가 target 프레임을 계속 cover 하도록 클램프
          posX = Math.min(0, Math.max(target.w - newW, posX));
          posY = Math.min(0, Math.max(target.h - newH, posY));
          ly.x = posX;
          ly.y = posY;
        } else {
          ly.x = (target.w - newW) / 2;
          ly.y = (target.h - newH) / 2;
        }
      } else {
        // 컨테이너 (image fill 없는 그룹/프레임) — 새 프레임 크기로 강제
        if (typeof ly.resize === "function") {
          ly.resize(target.w, target.h);
        }
        ly.x = 0;
        ly.y = 0;
        // 안의 cover-scale 이미지가 컨테이너 경계에 갇히지 않도록 clip 해제
        // (cover 컨테이너 본인은 어차피 원본 프레임 크기와 동일해서 시각적 차이 없음)
        const fy = info.node as unknown as { clipsContent?: boolean };
        if (typeof fy.clipsContent === "boolean") {
          fy.clipsContent = false;
        }
      }
    }

    // [이미지 모드 적용]
    //   ① 저장된 포컬포인트가 있으면 그 위치 중심으로 크롭
    //   ② 그 외는 무조건 FILL 모드로 강제 → 절대 안 찌그러짐
    applyROIsInNode(copy);

    // [사이즈별 자동 스타일 적용] — SIZE_STYLES 에 정의가 있는 사이즈만
    await applyStyleToBanner(copy, target.id);

    created.push(copy);
    offsetX += target.w + gap;
  }

  figma.currentPage.selection = created;
  figma.viewport.scrollAndZoomIntoView(created);
  figma.notify("✅ " + created.length + "개 사이즈의 배너를 만들었어요!");
  postSelectionStatus();
}

// ============================================================
// 기능 2) 텍스트 동기화
// ============================================================
async function syncText(): Promise<void> {
  const selection = figma.currentPage.selection;
  if (selection.length !== 1) {
    figma.notify("⚠️ 원본 프레임 1개를 먼저 선택해주세요.");
    return;
  }
  const source = selection[0];
  if (
    source.type !== "FRAME" &&
    source.type !== "COMPONENT" &&
    source.type !== "INSTANCE"
  ) {
    figma.notify("⚠️ 프레임을 선택해주세요.");
    return;
  }
  const children = findChildBanners(source.id);
  if (children.length === 0) {
    figma.notify(
      "⚠️ 이 원본으로 만든 배너가 없어요. 먼저 '사이즈 생성'으로 만들어주세요."
    );
    return;
  }

  backTagChildrenIfNeeded(source, children);

  const sourceById: { [id: string]: string } = {};
  const sourceByName: { [name: string]: string } = {};
  collectTexts(source, (t) => {
    const tid = t.getPluginData(TEXT_ID_KEY);
    if (tid) sourceById[tid] = t.characters;
    sourceByName[t.name] = t.characters;
  });

  let updatedCount = 0;
  for (const child of children) {
    const childTexts: TextNode[] = [];
    collectTexts(child, (t) => childTexts.push(t));
    for (const childText of childTexts) {
      const childTid = childText.getPluginData(TEXT_ID_KEY);
      let newContent: string | undefined;
      if (childTid && sourceById[childTid] !== undefined) {
        newContent = sourceById[childTid];
      } else if (sourceByName[childText.name] !== undefined) {
        newContent = sourceByName[childText.name];
      } else {
        continue;
      }
      if (childText.characters === newContent) continue;
      await loadFontsForText(childText);
      childText.characters = newContent;
      updatedCount++;
    }
  }

  if (updatedCount === 0) {
    figma.notify(
      "⚠️ 갱신할 텍스트가 없어요. 원본 텍스트를 정말 수정하셨는지 확인해주세요."
    );
  } else {
    figma.notify(
      "✅ " +
        children.length +
        "개 배너의 텍스트 " +
        updatedCount +
        "개를 동기화했어요!"
    );
  }
}

// ============================================================
// 기능 3) 포컬포인트 — 목록 / 바이트 전송 / 저장·삭제
// ============================================================
interface ImageInfo {
  imageHash: string;
  layerName: string;
  width: number;
  height: number;
  hasROI: boolean;
}

function postImagesList(): void {
  figma.ui.postMessage({ type: "images-list", images: getImagesInSelection() });
}

function getImagesInSelection(): ImageInfo[] {
  const selection = figma.currentPage.selection;
  const seen: { [hash: string]: boolean } = {};
  const result: ImageInfo[] = [];
  for (const node of selection) {
    collectImageFillNodes(node, (layer, paint) => {
      if (!paint.imageHash || seen[paint.imageHash]) return;
      seen[paint.imageHash] = true;
      const anyLayer = layer as unknown as { width: number; height: number };
      result.push({
        imageHash: paint.imageHash,
        layerName: layer.name,
        width: Math.round(anyLayer.width || 0),
        height: Math.round(anyLayer.height || 0),
        hasROI: !!loadROI(paint.imageHash),
      });
    });
  }
  return result;
}

async function sendImageBytes(imageHash: string): Promise<void> {
  const image = figma.getImageByHash(imageHash);
  if (!image) {
    figma.notify("⚠️ 이미지를 찾을 수 없어요.");
    return;
  }
  const bytes = await image.getBytesAsync();
  const base64 = figma.base64Encode(bytes);
  figma.ui.postMessage({
    type: "image-bytes",
    imageHash,
    base64,
    existingROI: loadROI(imageHash),
  });
}

function loadROI(imageHash: string): ROI | null {
  const data = figma.root.getPluginData(ROI_KEY_PREFIX + imageHash);
  if (!data) return null;
  try {
    return JSON.parse(data) as ROI;
  } catch (e) {
    return null;
  }
}
function saveROI(imageHash: string, roi: ROI): void {
  figma.root.setPluginData(ROI_KEY_PREFIX + imageHash, JSON.stringify(roi));
}
function clearROI(imageHash: string): void {
  figma.root.setPluginData(ROI_KEY_PREFIX + imageHash, "");
}

// ============================================================
// 핵심 수학: ROI(칠한 영역) + 타겟 비율 → imageTransform 행렬
// ============================================================
// 좌표는 모두 [0..1] 로 정규화된 이미지 공간입니다.
// 사용자가 선택한 옵션: "ROI 중심을 맞추고 가능한 많이 보이게"
//   1) 타겟 비율(layerW/layerH)로, ROI 를 다 담는 가장 작은 사각형 만들기
//   2) 이미지 경계 밖이면 줄이기
//   3) ROI 중심에 맞추되 이미지 안에 들어오도록 클램프
//
// imageTransform 형식 (Figma 공식, autocropper 레퍼런스로 검증):
//   [[subW,    0, subX],
//    [   0, subH, subY]]
function computeCropTransform(
  roi: ROI,
  layerW: number,
  layerH: number
): Transform {
  const targetAspect = layerW / layerH;
  const roiCx = roi.x + roi.w / 2;
  const roiCy = roi.y + roi.h / 2;

  let subW = Math.max(roi.w, roi.h * targetAspect);
  let subH = subW / targetAspect;

  if (subW > 1) {
    subW = 1;
    subH = subW / targetAspect;
  }
  if (subH > 1) {
    subH = 1;
    subW = subH * targetAspect;
    if (subW > 1) subW = 1; // 이미지 비율이 타겟과 너무 다를 때 — 일부 ROI 잘릴 수 있음
  }

  let subX = roiCx - subW / 2;
  let subY = roiCy - subH / 2;
  subX = Math.max(0, Math.min(1 - subW, subX));
  subY = Math.max(0, Math.min(1 - subH, subY));

  return [
    [subW, 0, subX],
    [0, subH, subY],
  ];
}

// 노드와 자손들 안의 모든 이미지 fill 에 대해 저장된 ROI 를 적용합니다.
function applyROIsInNode(node: SceneNode): void {
  const anyNode = node as unknown as { width: number; height: number; fills: Paint[] };
  if ("fills" in node && node.fills !== figma.mixed) {
    const newFills: Paint[] = JSON.parse(JSON.stringify(node.fills));
    let modified = false;
    for (let i = 0; i < newFills.length; i++) {
      const paint = newFills[i];
      if (paint.type === "IMAGE" && paint.imageHash) {
        // 포컬은 더 이상 CROP transform 으로 적용하지 않고 (찌그러짐 원인),
        // cover scale + layer 위치로 적용 (generateBanners 의 cover restore).
        // 그래서 image fill 은 항상 FILL 모드 + 변환 제거 → 절대 안 찌그러짐.
        const cleanPaint: { [k: string]: unknown } = { ...paint, scaleMode: "FILL" };
        delete cleanPaint.imageTransform;
        if (paint.scaleMode !== "FILL" || paint.imageTransform) {
          newFills[i] = cleanPaint as unknown as Paint;
          modified = true;
        }
      }
    }
    if (modified) {
      anyNode.fills = newFills;
    }
  }
  if ("children" in node) {
    for (const child of node.children) {
      applyROIsInNode(child);
    }
  }
}

// ============================================================
// 기능 4) 사이즈별 텍스트·CTA 스타일 자동 적용
//        SIZE_STYLES 에 정의된 사이즈일 때만 동작 (다른 사이즈는 무시).
// ============================================================

// 트리 안에서 이름이 정확히 일치하는 첫 레이어 찾기
function findByExactName(node: SceneNode, name: string): SceneNode | null {
  if (node.name === name) return node;
  if ("children" in node) {
    for (const child of node.children) {
      const found = findByExactName(child, name);
      if (found) return found;
    }
  }
  return null;
}

// 생성된 배너에 사이즈별 스타일을 적용합니다.
// 현재 동작: SIZE_STYLES 에 textboxPosition 이 정의돼 있으면
// "textbox" 이름의 레이어(그룹/프레임)를 그 위치(X, Y)로 이동.
// 폰트·텍스트·정렬·CTA 박스 등 모든 스타일은 원본 디자인 그대로 유지.
async function applyStyleToBanner(
  banner: SceneNode,
  sizeId: string
): Promise<void> {
  const config = SIZE_STYLES[sizeId];
  if (!config) return;

  if (config.textboxPosition) {
    const textbox = findByExactName(banner, "textbox");
    if (textbox) {
      const ly = textbox as unknown as { x: number; y: number };
      ly.x = config.textboxPosition.x;
      ly.y = config.textboxPosition.y;
    }
  }

  // CTA / Body / Title 의 x = 0 (textbox 안에서 좌측 정렬)
  for (const name of ["CTA", "Body", "Title"]) {
    const layer = findByExactName(banner, name);
    if (layer) {
      (layer as unknown as { x: number }).x = 0;
    }
  }

  // Title 안에 들어있는 텍스트 레이어들(2개) 의 x 도 모두 0 으로
  // (직접 child 가 아니어도 재귀로 모두 잡음)
  const titleLayer = findByExactName(banner, "Title");
  if (titleLayer) {
    const setInnerTextsX = (node: SceneNode): void => {
      if ("children" in node) {
        for (const child of node.children) {
          if (child.type === "TEXT") {
            (child as unknown as { x: number }).x = 0;
          }
          setInnerTextsX(child);
        }
      }
    };
    setInnerTextsX(titleLayer);
  }
}

// ============================================================
// 도우미 함수들
// ============================================================
function findChildBanners(sourceId: string): SceneNode[] {
  return figma.currentPage.findAll(
    (n) => n.getPluginData(SOURCE_KEY) === sourceId
  );
}

function collectTexts(node: SceneNode, callback: (t: TextNode) => void): void {
  if (node.type === "TEXT") {
    callback(node);
    return;
  }
  if ("children" in node) {
    for (const child of node.children) collectTexts(child, callback);
  }
}

function ensureTextIds(node: SceneNode): void {
  collectTexts(node, (t) => {
    if (!t.getPluginData(TEXT_ID_KEY)) {
      t.setPluginData(
        TEXT_ID_KEY,
        String(Date.now()) + "-" + Math.random().toString(36).slice(2, 11)
      );
    }
  });
}

function backTagChildrenIfNeeded(
  source: SceneNode,
  children: SceneNode[]
): void {
  const sourceTexts: TextNode[] = [];
  collectTexts(source, (t) => sourceTexts.push(t));
  for (const t of sourceTexts) {
    if (!t.getPluginData(TEXT_ID_KEY)) {
      t.setPluginData(
        TEXT_ID_KEY,
        String(Date.now()) + "-" + Math.random().toString(36).slice(2, 11)
      );
    }
  }
  for (const child of children) {
    const childTexts: TextNode[] = [];
    collectTexts(child, (t) => childTexts.push(t));
    const n = Math.min(sourceTexts.length, childTexts.length);
    for (let i = 0; i < n; i++) {
      if (!childTexts[i].getPluginData(TEXT_ID_KEY)) {
        childTexts[i].setPluginData(
          TEXT_ID_KEY,
          sourceTexts[i].getPluginData(TEXT_ID_KEY)
        );
      }
    }
  }
}

async function loadFontsForText(text: TextNode): Promise<void> {
  if (text.fontName === figma.mixed) {
    const fonts = text.getRangeAllFontNames(0, text.characters.length);
    await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
  } else {
    await figma.loadFontAsync(text.fontName);
  }
}

// 이 노드 자체가 직접 image fill 을 가지고 있는지 (= leaf 이미지 노드 판별)
function hasOwnImageFill(node: SceneNode): boolean {
  if (!("fills" in node) || node.fills === figma.mixed) return false;
  return (node.fills as readonly Paint[]).some(
    (p) => p.type === "IMAGE" && !!p.imageHash
  );
}

// 노드(또는 자손) 안에 이미지 fill 이 하나라도 있는지 검사합니다.
// (cover 레이어를 찾을 때 "이 컨테이너가 이미지를 품고 있나?"를 확인하는 용도)
function containsImageFill(node: SceneNode): boolean {
  if ("fills" in node && node.fills !== figma.mixed) {
    if (
      (node.fills as readonly Paint[]).some(
        (p) => p.type === "IMAGE" && !!p.imageHash
      )
    ) {
      return true;
    }
  }
  if ("children" in node) {
    for (const child of node.children) {
      if (containsImageFill(child)) return true;
    }
  }
  return false;
}

function collectImageFillNodes(
  node: SceneNode,
  callback: (layer: SceneNode, paint: ImagePaint) => void
): void {
  if ("fills" in node && node.fills !== figma.mixed) {
    for (const paint of node.fills) {
      if (paint.type === "IMAGE" && paint.imageHash) {
        callback(node, paint);
      }
    }
  }
  if ("children" in node) {
    for (const child of node.children) {
      collectImageFillNodes(child, callback);
    }
  }
}

function postSelectionStatus(): void {
  const selection = figma.currentPage.selection;
  if (
    selection.length === 1 &&
    (selection[0].type === "FRAME" ||
      selection[0].type === "COMPONENT" ||
      selection[0].type === "INSTANCE")
  ) {
    const source = selection[0];
    const children = findChildBanners(source.id);
    figma.ui.postMessage({
      type: "selection-status",
      sourceName: source.name,
      childCount: children.length,
    });
  } else {
    figma.ui.postMessage({
      type: "selection-status",
      sourceName: null,
      childCount: 0,
    });
  }
}
