"use strict";
/// <reference types="@figma/plugin-typings" />
// ↑ 피그마 전용 명령어의 타입 정보를 불러오는 줄입니다. 지우지 마세요.
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
// ============================================================
// Banner Resizer — 플러그인의 "두뇌" 파일
// 3가지 기능:
//   1) 사이즈 생성 — 원본 프레임을 여러 광고 사이즈로 복제
//   2) 텍스트 동기화 — 원본 수정 시 자식 배너에 자동 전파
//   3) 포컬포인트 — 이미지의 중요 영역을 브러쉬로 칠해 저장하면,
//                  생성 시 그 영역이 중심에 오도록 자동 크롭
// ============================================================
const PRESET_SIZES = [
    { id: "s_1920x1080", label: "1920 × 1080", w: 1920, h: 1080 },
    { id: "s_780x780", label: "780 × 780", w: 780, h: 780 },
    { id: "s_600x600", label: "600 × 600", w: 600, h: 600 },
    { id: "s_700x240", label: "700 × 240", w: 700, h: 240 },
    { id: "s_720x1248", label: "720 × 1248", w: 720, h: 1248 },
    { id: "s_720x1080", label: "720 × 1080", w: 720, h: 1080 },
];
const SIZE_STYLES = {
    s_1920x1080: { textboxPosition: { x: 240, y: 390 } },
    // 다른 사이즈는 사용자 데이터 받는 대로 추가
};
const SOURCE_KEY = "bannerResizer.sourceFrameId"; // 자식 배너 → 원본 ID
const TEXT_ID_KEY = "bannerResizer.textId"; // 텍스트 → 안정 ID
const ROI_KEY_PREFIX = "bannerResizer.roi."; // 이미지 해시 → ROI(JSON), figma.root 에 저장
figma.showUI(__html__, { width: 360, height: 620 });
// 선택이 바뀌면 두 탭의 상태(동기화·포컬)를 모두 갱신
figma.on("selectionchange", () => {
    postSelectionStatus();
    postImagesList();
});
figma.ui.onmessage = (msg) => __awaiter(void 0, void 0, void 0, function* () {
    if (msg.type === "generate") {
        yield generateBanners(msg.selectedSizeIds || []);
    }
    else if (msg.type === "sync") {
        yield syncText();
    }
    else if (msg.type === "request-status") {
        postSelectionStatus();
    }
    else if (msg.type === "request-images") {
        postImagesList();
    }
    else if (msg.type === "request-image-bytes" && msg.imageHash) {
        yield sendImageBytes(msg.imageHash);
    }
    else if (msg.type === "save-roi" && msg.imageHash && msg.roi) {
        saveROI(msg.imageHash, msg.roi);
        figma.notify("✅ 포컬포인트 저장됨");
        postImagesList();
    }
    else if (msg.type === "clear-roi" && msg.imageHash) {
        clearROI(msg.imageHash);
        figma.notify("⨯ 포컬포인트 삭제됨");
        postImagesList();
    }
    else if (msg.type === "cancel") {
        figma.closePlugin();
    }
});
// ============================================================
// 기능 1) 사이즈 생성
// ============================================================
function generateBanners(selectedSizeIds) {
    return __awaiter(this, void 0, void 0, function* () {
        const selection = figma.currentPage.selection;
        if (selection.length !== 1) {
            figma.notify("⚠️ 배너로 만들 프레임 1개를 먼저 선택해주세요.");
            return;
        }
        const source = selection[0];
        if (source.type !== "FRAME" &&
            source.type !== "COMPONENT" &&
            source.type !== "INSTANCE") {
            figma.notify("⚠️ 프레임(Frame)을 선택해주세요.");
            return;
        }
        const targets = PRESET_SIZES.filter((s) => selectedSizeIds.indexOf(s.id) !== -1);
        if (targets.length === 0) {
            figma.notify("⚠️ 만들 사이즈를 최소 1개 이상 체크해주세요.");
            return;
        }
        ensureTextIds(source);
        const gap = 80;
        const startY = source.y + source.height + gap;
        let offsetX = source.x;
        const created = [];
        for (const target of targets) {
            const copy = source.clone();
            figma.currentPage.appendChild(copy);
            copy.name = target.label;
            // [cover 레이어 식별] — 리사이즈 전에 각 레이어의 메타 정보를 미리 캡쳐.
            //   origW/origH: 원래 크기 (포컬 없는 이미지는 그대로 유지하려고)
            //   isLeaf:      자기 자신이 직접 image fill 을 가진 leaf 인지
            //   hasFocal:    그 leaf 의 이미지에 포컬포인트가 저장돼 있는지
            const copyBox = copy.absoluteBoundingBox;
            const coverInfos = [];
            const collectCovers = (node) => {
                if (node !== copy && copyBox) {
                    const lb = node.absoluteBoundingBox;
                    // 레이어가 원본 프레임 영역을 "덮음" (정확히 일치 OR 더 커서 밖으로 삐져나옴) 인지 검사.
                    // 이렇게 해야 원본 프레임 밖으로 여백이 삐져나와 있는 이미지 레이어도 cover 로 잡힘.
                    if (lb &&
                        lb.x <= copyBox.x + 1 &&
                        lb.y <= copyBox.y + 1 &&
                        lb.x + lb.width >= copyBox.x + copyBox.width - 1 &&
                        lb.y + lb.height >= copyBox.y + copyBox.height - 1 &&
                        containsImageFill(node)) {
                        const isLeaf = hasOwnImageFill(node);
                        let hasFocal = false;
                        if (isLeaf && "fills" in node && node.fills !== figma.mixed) {
                            hasFocal = node.fills.some((p) => p.type === "IMAGE" && !!p.imageHash && !!loadROI(p.imageHash));
                        }
                        const ly = node;
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
                    for (const child of node.children)
                        collectCovers(child);
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
                const ly = info.node;
                if (info.isLeaf && !info.hasFocal) {
                    // ③ 포컬 없는 이미지 — 원본 비율 유지하며 새 프레임을 cover.
                    //   scale = max(target.w/origW, target.h/origH)
                    //     → 양쪽 모두 frame 을 덮는 가장 작은 비율 (= cover)
                    //   결과: 한 쪽은 딱 맞고, 다른 한 쪽은 frame 밖으로 삐져나옴.
                    //   레이어 비율 = 이미지 비율이라 image fill (FILL 모드) 은 비율 정확히 일치 → 크롭/왜곡 없음.
                    //   frame.clipsContent 가 알아서 잘라주고, 디자이너는 드래그로 위치 조정 가능.
                    const scale = Math.max(target.w / info.origW, target.h / info.origH);
                    const newW = info.origW * scale;
                    const newH = info.origH * scale;
                    if (typeof ly.resize === "function") {
                        ly.resize(newW, newH);
                    }
                    ly.x = (target.w - newW) / 2;
                    ly.y = (target.h - newH) / 2;
                }
                else {
                    // ①② 컨테이너 또는 포컬 있는 이미지 — 새 프레임 크기로 강제
                    if (typeof ly.resize === "function") {
                        ly.resize(target.w, target.h);
                    }
                    ly.x = 0;
                    ly.y = 0;
                    // [컨테이너의 clip 비활성화] — 안에 있는 cover-scale 이미지가
                    // 컨테이너 경계에 갇히지 않도록 함. 결과적으로 이미지는 원본 프레임
                    // 경계까지만 잘리고, 디자이너님이 자유롭게 드래그할 수 있어요.
                    // (cover 컨테이너 본인은 어차피 원본 프레임 크기와 동일해서 시각적 차이 없음)
                    if (!info.isLeaf) {
                        const fy = info.node;
                        if (typeof fy.clipsContent === "boolean") {
                            fy.clipsContent = false;
                        }
                    }
                }
            }
            // [이미지 모드 적용]
            //   ① 저장된 포컬포인트가 있으면 그 위치 중심으로 크롭
            //   ② 그 외는 무조건 FILL 모드로 강제 → 절대 안 찌그러짐
            applyROIsInNode(copy);
            // [사이즈별 자동 스타일 적용] — SIZE_STYLES 에 정의가 있는 사이즈만
            yield applyStyleToBanner(copy, target.id);
            created.push(copy);
            offsetX += target.w + gap;
        }
        figma.currentPage.selection = created;
        figma.viewport.scrollAndZoomIntoView(created);
        figma.notify("✅ " + created.length + "개 사이즈의 배너를 만들었어요!");
        postSelectionStatus();
    });
}
// ============================================================
// 기능 2) 텍스트 동기화
// ============================================================
function syncText() {
    return __awaiter(this, void 0, void 0, function* () {
        const selection = figma.currentPage.selection;
        if (selection.length !== 1) {
            figma.notify("⚠️ 원본 프레임 1개를 먼저 선택해주세요.");
            return;
        }
        const source = selection[0];
        if (source.type !== "FRAME" &&
            source.type !== "COMPONENT" &&
            source.type !== "INSTANCE") {
            figma.notify("⚠️ 프레임을 선택해주세요.");
            return;
        }
        const children = findChildBanners(source.id);
        if (children.length === 0) {
            figma.notify("⚠️ 이 원본으로 만든 배너가 없어요. 먼저 '사이즈 생성'으로 만들어주세요.");
            return;
        }
        backTagChildrenIfNeeded(source, children);
        const sourceById = {};
        const sourceByName = {};
        collectTexts(source, (t) => {
            const tid = t.getPluginData(TEXT_ID_KEY);
            if (tid)
                sourceById[tid] = t.characters;
            sourceByName[t.name] = t.characters;
        });
        let updatedCount = 0;
        for (const child of children) {
            const childTexts = [];
            collectTexts(child, (t) => childTexts.push(t));
            for (const childText of childTexts) {
                const childTid = childText.getPluginData(TEXT_ID_KEY);
                let newContent;
                if (childTid && sourceById[childTid] !== undefined) {
                    newContent = sourceById[childTid];
                }
                else if (sourceByName[childText.name] !== undefined) {
                    newContent = sourceByName[childText.name];
                }
                else {
                    continue;
                }
                if (childText.characters === newContent)
                    continue;
                yield loadFontsForText(childText);
                childText.characters = newContent;
                updatedCount++;
            }
        }
        if (updatedCount === 0) {
            figma.notify("⚠️ 갱신할 텍스트가 없어요. 원본 텍스트를 정말 수정하셨는지 확인해주세요.");
        }
        else {
            figma.notify("✅ " +
                children.length +
                "개 배너의 텍스트 " +
                updatedCount +
                "개를 동기화했어요!");
        }
    });
}
function postImagesList() {
    figma.ui.postMessage({ type: "images-list", images: getImagesInSelection() });
}
function getImagesInSelection() {
    const selection = figma.currentPage.selection;
    const seen = {};
    const result = [];
    for (const node of selection) {
        collectImageFillNodes(node, (layer, paint) => {
            if (!paint.imageHash || seen[paint.imageHash])
                return;
            seen[paint.imageHash] = true;
            const anyLayer = layer;
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
function sendImageBytes(imageHash) {
    return __awaiter(this, void 0, void 0, function* () {
        const image = figma.getImageByHash(imageHash);
        if (!image) {
            figma.notify("⚠️ 이미지를 찾을 수 없어요.");
            return;
        }
        const bytes = yield image.getBytesAsync();
        const base64 = figma.base64Encode(bytes);
        figma.ui.postMessage({
            type: "image-bytes",
            imageHash,
            base64,
            existingROI: loadROI(imageHash),
        });
    });
}
function loadROI(imageHash) {
    const data = figma.root.getPluginData(ROI_KEY_PREFIX + imageHash);
    if (!data)
        return null;
    try {
        return JSON.parse(data);
    }
    catch (e) {
        return null;
    }
}
function saveROI(imageHash, roi) {
    figma.root.setPluginData(ROI_KEY_PREFIX + imageHash, JSON.stringify(roi));
}
function clearROI(imageHash) {
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
function computeCropTransform(roi, layerW, layerH) {
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
        if (subW > 1)
            subW = 1; // 이미지 비율이 타겟과 너무 다를 때 — 일부 ROI 잘릴 수 있음
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
function applyROIsInNode(node) {
    const anyNode = node;
    if ("fills" in node && node.fills !== figma.mixed) {
        const newFills = JSON.parse(JSON.stringify(node.fills));
        let modified = false;
        for (let i = 0; i < newFills.length; i++) {
            const paint = newFills[i];
            if (paint.type === "IMAGE" && paint.imageHash) {
                const roi = loadROI(paint.imageHash);
                if (roi) {
                    // ① 저장된 포컬포인트가 있으면 최우선 — 칠한 영역 중심으로 크롭
                    newFills[i] = Object.assign(Object.assign({}, paint), { scaleMode: "CROP", imageTransform: computeCropTransform(roi, anyNode.width, anyNode.height) });
                    modified = true;
                }
                else {
                    // ② 포컬포인트 없으면 무조건 FILL 모드 + 변환 제거.
                    //   FILL 모드여도 남아있는 imageTransform 이 영향을 줄 수 있어서
                    //   매번 새로 깨끗한 paint 를 만들어줍니다. 이러면 Figma 가
                    //   순수하게 "비율 유지한 채 덮기" 만 하므로 절대 찌그러지지 않음.
                    const cleanPaint = Object.assign(Object.assign({}, paint), { scaleMode: "FILL" });
                    delete cleanPaint.imageTransform;
                    // 이미 같은 상태면 굳이 갱신 안 함 (성능)
                    if (paint.scaleMode !== "FILL" || paint.imageTransform) {
                        newFills[i] = cleanPaint;
                        modified = true;
                    }
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
function findByExactName(node, name) {
    if (node.name === name)
        return node;
    if ("children" in node) {
        for (const child of node.children) {
            const found = findByExactName(child, name);
            if (found)
                return found;
        }
    }
    return null;
}
// 생성된 배너에 사이즈별 스타일을 적용합니다.
// 현재 동작: SIZE_STYLES 에 textboxPosition 이 정의돼 있으면
// "textbox" 이름의 레이어(그룹/프레임)를 그 위치(X, Y)로 이동.
// 폰트·텍스트·정렬·CTA 박스 등 모든 스타일은 원본 디자인 그대로 유지.
function applyStyleToBanner(banner, sizeId) {
    return __awaiter(this, void 0, void 0, function* () {
        const config = SIZE_STYLES[sizeId];
        if (!config)
            return;
        if (config.textboxPosition) {
            const textbox = findByExactName(banner, "textbox");
            if (textbox) {
                const ly = textbox;
                ly.x = config.textboxPosition.x;
                ly.y = config.textboxPosition.y;
            }
        }
    });
}
// ============================================================
// 도우미 함수들
// ============================================================
function findChildBanners(sourceId) {
    return figma.currentPage.findAll((n) => n.getPluginData(SOURCE_KEY) === sourceId);
}
function collectTexts(node, callback) {
    if (node.type === "TEXT") {
        callback(node);
        return;
    }
    if ("children" in node) {
        for (const child of node.children)
            collectTexts(child, callback);
    }
}
function ensureTextIds(node) {
    collectTexts(node, (t) => {
        if (!t.getPluginData(TEXT_ID_KEY)) {
            t.setPluginData(TEXT_ID_KEY, String(Date.now()) + "-" + Math.random().toString(36).slice(2, 11));
        }
    });
}
function backTagChildrenIfNeeded(source, children) {
    const sourceTexts = [];
    collectTexts(source, (t) => sourceTexts.push(t));
    for (const t of sourceTexts) {
        if (!t.getPluginData(TEXT_ID_KEY)) {
            t.setPluginData(TEXT_ID_KEY, String(Date.now()) + "-" + Math.random().toString(36).slice(2, 11));
        }
    }
    for (const child of children) {
        const childTexts = [];
        collectTexts(child, (t) => childTexts.push(t));
        const n = Math.min(sourceTexts.length, childTexts.length);
        for (let i = 0; i < n; i++) {
            if (!childTexts[i].getPluginData(TEXT_ID_KEY)) {
                childTexts[i].setPluginData(TEXT_ID_KEY, sourceTexts[i].getPluginData(TEXT_ID_KEY));
            }
        }
    }
}
function loadFontsForText(text) {
    return __awaiter(this, void 0, void 0, function* () {
        if (text.fontName === figma.mixed) {
            const fonts = text.getRangeAllFontNames(0, text.characters.length);
            yield Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
        }
        else {
            yield figma.loadFontAsync(text.fontName);
        }
    });
}
// 이 노드 자체가 직접 image fill 을 가지고 있는지 (= leaf 이미지 노드 판별)
function hasOwnImageFill(node) {
    if (!("fills" in node) || node.fills === figma.mixed)
        return false;
    return node.fills.some((p) => p.type === "IMAGE" && !!p.imageHash);
}
// 노드(또는 자손) 안에 이미지 fill 이 하나라도 있는지 검사합니다.
// (cover 레이어를 찾을 때 "이 컨테이너가 이미지를 품고 있나?"를 확인하는 용도)
function containsImageFill(node) {
    if ("fills" in node && node.fills !== figma.mixed) {
        if (node.fills.some((p) => p.type === "IMAGE" && !!p.imageHash)) {
            return true;
        }
    }
    if ("children" in node) {
        for (const child of node.children) {
            if (containsImageFill(child))
                return true;
        }
    }
    return false;
}
function collectImageFillNodes(node, callback) {
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
function postSelectionStatus() {
    const selection = figma.currentPage.selection;
    if (selection.length === 1 &&
        (selection[0].type === "FRAME" ||
            selection[0].type === "COMPONENT" ||
            selection[0].type === "INSTANCE")) {
        const source = selection[0];
        const children = findChildBanners(source.id);
        figma.ui.postMessage({
            type: "selection-status",
            sourceName: source.name,
            childCount: children.length,
        });
    }
    else {
        figma.ui.postMessage({
            type: "selection-status",
            sourceName: null,
            childCount: 0,
        });
    }
}
