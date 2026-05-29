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
    s_1920x1080: {
        container: {
            x: 240,
            y: 390,
            gapTitleBody: 40,
            gapBodyCTA: 30,
            gapInsideTextBox: 4, // Title/Body FRAME 안 텍스트들 사이 간격
            textAlign: "LEFT", // 모든 텍스트 일괄 왼쪽 정렬
        },
        title: {
            // Figma Dev Mode export 에 따라 family 이름에 weight 가 포함되어 있음.
            // 그래서 fontWeight 는 400(=Regular style) 로 두고 family 이름이 weight 를 표현.
            fontFamilyEn: "Samsung Sharp Sans-Bold",
            fontFamilyKo: "SamsungOneKoreanOTF-700",
            fontSize: 58,
            fontWeight: 400,
            color: "#FFFFFF",
            textAlign: "LEFT",
        },
        body: {
            fontFamily: "SamsungOneKoreanOTF-400",
            fontSize: 28,
            fontWeight: 400,
            color: "#FFFFFF",
            textAlign: "LEFT",
        },
        ctaText: {
            // CTA 텍스트는 family 가 "-700" (= 굵은 글씨), style 은 Regular.
            fontFamily: "SamsungOneKoreanOTF-700",
            fontSize: 14,
            fontWeight: 400,
            color: "#000000",
            textAlign: "LEFT",
        },
        ctaBox: {
            width: 122,
            height: 40,
            cornerRadius: 20,
            fillHex: "#D9D9D9",
            strokeHex: "#FFFFFF",
            strokeWidth: 1,
        },
    },
    // 다른 사이즈는 사용자 데이터 받는 대로 같은 양식으로 추가
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
// CSS font-weight 숫자 → Figma 폰트 스타일 이름 매핑
function fontStyleForWeight(weight) {
    if (weight >= 900)
        return "Black";
    if (weight >= 800)
        return "ExtraBold";
    if (weight >= 700)
        return "Bold";
    if (weight >= 600)
        return "SemiBold";
    if (weight >= 500)
        return "Medium";
    if (weight >= 400)
        return "Regular";
    if (weight >= 300)
        return "Light";
    if (weight >= 200)
        return "ExtraLight";
    return "Thin";
}
// 텍스트에 한글이 한 글자라도 있는지 검사 (Title 의 폰트 자동 결정용)
function hasKoreanText(text) {
    return /[가-힯ㄱ-ㆎᄀ-ᇿ]/.test(text);
}
// #FFF / #FFFFFF / #FFFFFFFF → Figma RGB (0~1 범위)
function hexToRGB(hex) {
    let h = hex.replace("#", "").trim();
    if (h.length === 3)
        h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length === 8)
        h = h.substring(0, 6); // 알파 무시
    return {
        r: parseInt(h.substring(0, 2), 16) / 255,
        g: parseInt(h.substring(2, 4), 16) / 255,
        b: parseInt(h.substring(4, 6), 16) / 255,
    };
}
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
// 트리 안에서 이름이 정확히 일치하는 모든 레이어 찾기
// (예: "Title" 이라는 텍스트 레이어가 여러 개 있을 때 — 영문줄/한글줄 분리되어 있는 경우)
function findAllByExactName(node, name) {
    const results = [];
    const walk = (n) => {
        if (n.name === name)
            results.push(n);
        if ("children" in n) {
            for (const child of n.children)
                walk(child);
        }
    };
    walk(node);
    return results;
}
// CTA 컨테이너 안 첫 텍스트 노드 찾기 (라벨 텍스트 스타일 적용용)
function findFirstTextInside(node) {
    if (node.type === "TEXT")
        return node;
    if ("children" in node) {
        for (const child of node.children) {
            const found = findFirstTextInside(child);
            if (found)
                return found;
        }
    }
    return null;
}
// 한 텍스트 노드에 TextSpec 을 적용.
// 폰트 로드가 실패해도 size · lineHeight · color · align 은 그대로 적용되도록 단계 분리.
function applyTextSpec(text, spec) {
    return __awaiter(this, void 0, void 0, function* () {
        // 폰트 패밀리: en/ko 양쪽 사양이 있으면 텍스트 내용으로 자동 감지
        let family;
        if (spec.fontFamilyEn && spec.fontFamilyKo) {
            family = hasKoreanText(text.characters)
                ? spec.fontFamilyKo
                : spec.fontFamilyEn;
        }
        else {
            family = spec.fontFamily || spec.fontFamilyKo || spec.fontFamilyEn || "Inter";
        }
        const style = fontStyleForWeight(spec.fontWeight);
        const fontName = { family, style };
        // 1) 기존 폰트 로드 시도 (실패해도 계속 — 일부 속성은 그래도 적용될 수 있음)
        try {
            yield loadFontsForText(text);
        }
        catch (e) {
            // 기존 폰트 누락 시 일부 속성 변경이 어려울 수 있지만, 일단 계속 진행
        }
        // 2) 새 폰트 로드 + fontName 변경 시도
        try {
            yield figma.loadFontAsync(fontName);
            text.fontName = fontName;
        }
        catch (e) {
            figma.notify("⚠️ 폰트 누락: " + family + " " + style + " — 폰트는 그대로, 나머지 적용 시도");
        }
        // 3) 각 속성을 독립 try/catch 로 처리 — 하나가 실패해도 다른 속성은 시도
        try {
            text.fontSize = spec.fontSize;
        }
        catch (e) { }
        try {
            text.lineHeight = { unit: "AUTO" };
        }
        catch (e) { }
        try {
            text.fills = [{ type: "SOLID", color: hexToRGB(spec.color) }];
        }
        catch (e) { }
        if (spec.textAlign) {
            try {
                text.textAlignHorizontal = spec.textAlign;
            }
            catch (e) { }
        }
    });
}
// Title 과 Body 가 같은 부모의 평행 sibling 이라면 둘을 묶는 wrapper frame 을 생성.
// 이렇게 해야 Title↔Body gap (예: 40) 과 Body↔CTA gap (예: 30) 을 동시에 표현 가능.
// (Figma auto-layout 의 itemSpacing 은 컨테이너당 1개라서 nesting 이 필요)
function ensureNestedStructure(banner) {
    const title = findByExactName(banner, "Title");
    const body = findByExactName(banner, "Body");
    if (!title || !body)
        return;
    if (title.parent !== body.parent)
        return; // 이미 nested 구조
    if (title.parent === banner)
        return; // 배너 자체가 부모면 nesting 안 함
    const parent = title.parent;
    if (!parent || !parent.layoutMode || parent.layoutMode === "NONE")
        return;
    if (!parent.children || !parent.insertChild)
        return;
    // wrapper frame 생성 (Title 과 Body 를 묶는 안쪽 그룹)
    const wrapper = figma.createFrame();
    wrapper.name = "Title-Body Group";
    wrapper.layoutMode = parent.layoutMode;
    wrapper.primaryAxisSizingMode = "AUTO";
    wrapper.counterAxisSizingMode = "AUTO";
    wrapper.fills = [];
    wrapper.clipsContent = false;
    // Title 의 위치(낮은 쪽 index) 에 wrapper 삽입
    const titleIdx = parent.children.indexOf(title);
    const bodyIdx = parent.children.indexOf(body);
    const minIdx = Math.min(titleIdx, bodyIdx);
    parent.insertChild(minIdx, wrapper);
    // Title 과 Body 를 wrapper 안으로 이동 (Title → Body 순서)
    wrapper.appendChild(title);
    wrapper.appendChild(body);
}
// 생성된 배너에 사이즈별 스타일을 적용합니다.
function applyStyleToBanner(banner, sizeId) {
    return __awaiter(this, void 0, void 0, function* () {
        const config = SIZE_STYLES[sizeId];
        if (!config)
            return; // 정의 없으면 그대로 둠
        // 0) 구조 보정 — Title, Body 가 평행 sibling 이면 wrapper 로 묶음
        //    (Figma auto-layout 의 itemSpacing 은 1개뿐이라 gap 두 개를 표현하려면 nesting 필요)
        ensureNestedStructure(banner);
        // 1) Title — "Title" 이름의 레이어들 찾기. TEXT 면 직접, FRAME/GROUP 이면 안 텍스트들 모두.
        //    각 텍스트는 내용을 보고 KR/EN 폰트를 자동 감지해 적용.
        const titleNodes = findAllByExactName(banner, "Title");
        const titleTexts = [];
        for (const c of titleNodes) {
            if (c.type === "TEXT") {
                titleTexts.push(c);
            }
            else {
                collectTexts(c, (t) => titleTexts.push(t));
            }
        }
        for (const t of titleTexts) {
            yield applyTextSpec(t, config.title);
        }
        // 2) Body — 마찬가지로 (TEXT 또는 FRAME 안 텍스트들)
        const bodyNodes = findAllByExactName(banner, "Body");
        const bodyTexts = [];
        for (const c of bodyNodes) {
            if (c.type === "TEXT") {
                bodyTexts.push(c);
            }
            else {
                collectTexts(c, (t) => bodyTexts.push(t));
            }
        }
        for (const t of bodyTexts) {
            yield applyTextSpec(t, config.body);
        }
        // 3) CTA — 박스 + 안 텍스트
        const ctaNode = findByExactName(banner, "CTA");
        if (ctaNode) {
            const cy = ctaNode;
            if (typeof cy.resize === "function") {
                cy.resize(config.ctaBox.width, config.ctaBox.height);
            }
            if ("cornerRadius" in cy)
                cy.cornerRadius = config.ctaBox.cornerRadius;
            cy.fills = [{ type: "SOLID", color: hexToRGB(config.ctaBox.fillHex) }];
            cy.strokes = [
                { type: "SOLID", color: hexToRGB(config.ctaBox.strokeHex) },
            ];
            cy.strokeWeight = config.ctaBox.strokeWidth;
            // CTA 안 첫 텍스트
            const ctaInnerText = findFirstTextInside(ctaNode);
            if (ctaInnerText) {
                yield applyTextSpec(ctaInnerText, config.ctaText);
            }
        }
        // 4) Title-Body 그룹과 text container 의 위치·간격 설정
        //   가정 구조 (중첩 OK):
        //     배너
        //     └── text container (CTA 의 부모, gap=30, X/Y)
        //         ├── Title-Body 그룹 (Body 의 부모, gap=40)
        //         │   ├── (headline subgroup ─ 옵션, 다중 Title 묶음용)
        //         │   │   ├── Title
        //         │   │   └── Title
        //         │   └── Body
        //         └── CTA
        //
        //   ※ Body 의 부모를 기준으로 gapTitleBody 를 설정 → 다중 Title 의 headline subgroup 의 안쪽 간격은 안 건드림
        //   (Body 가 frame 인 경우에도 작동하도록 .find 대신 [0] 사용)
        const firstBody = bodyNodes[0];
        if (firstBody && firstBody.parent) {
            const bp = firstBody.parent;
            if (bp.layoutMode && bp.layoutMode !== "NONE") {
                bp.itemSpacing = config.container.gapTitleBody;
            }
        }
        // text container — CTA 의 부모 (단, 부모가 배너 자체면 위치 안 바꿈)
        //   - itemSpacing = gapBodyCTA (안 children 간 간격)
        //   - primaryAxisSizingMode / counterAxisSizingMode = "AUTO" → hug content
        //   - x, y 강제 (배너 안 절대 위치)
        if (ctaNode && ctaNode.parent && ctaNode.parent !== banner) {
            const cp = ctaNode.parent;
            if (cp.layoutMode && cp.layoutMode !== "NONE") {
                cp.itemSpacing = config.container.gapBodyCTA;
                cp.primaryAxisSizingMode = "AUTO";
                cp.counterAxisSizingMode = "AUTO";
            }
            // ★ 핵심: 배너 안에서 text container 의 절대 위치 강제
            cp.x = config.container.x;
            cp.y = config.container.y;
        }
        // 4.5) Title/Body FRAME 의 layout — Figma 의 inline-flex 동작 재현
        //      - itemSpacing = gapInsideTextBox (안쪽 텍스트 사이 간격)
        //      - primaryAxisAlignItems = "CENTER"  ← justify-content: center
        //      - primaryAxisSizingMode = "AUTO"    ← hug content (vertical)
        //      - counterAxisSizingMode = "AUTO"    ← hug content (horizontal)
        //      (counterAxisAlignItems = "MIN" 은 step 6 의 LEFT cascade 에서 설정됨)
        {
            const frames = [];
            for (const n of titleNodes)
                if (n.type !== "TEXT")
                    frames.push(n);
            for (const n of bodyNodes)
                if (n.type !== "TEXT")
                    frames.push(n);
            for (const f of frames) {
                if ("layoutMode" in f) {
                    const fy = f;
                    if (fy.layoutMode && fy.layoutMode !== "NONE") {
                        if (config.container.gapInsideTextBox !== undefined) {
                            fy.itemSpacing = config.container.gapInsideTextBox;
                        }
                        fy.primaryAxisAlignItems = "CENTER";
                        fy.primaryAxisSizingMode = "AUTO";
                        fy.counterAxisSizingMode = "AUTO";
                    }
                }
            }
        }
        // 5) 배너 안 모든 텍스트에 일괄 처리
        //    - textAutoResize = "WIDTH_AND_HEIGHT" → 텍스트 길이에 맞춰 박스 자동 hug
        //      (CTA 안 텍스트가 잘리는 문제 방지 — 모든 텍스트 박스가 글자 길이 따라 자동 조절)
        //    - container.textAlign 이 있으면 모든 텍스트에 일괄 정렬 적용
        const allTexts = [];
        collectTexts(banner, (t) => allTexts.push(t));
        for (const t of allTexts) {
            try {
                yield loadFontsForText(t); // 텍스트 속성 변경 전 필수
                t.textAutoResize = "WIDTH_AND_HEIGHT";
                if (config.container.textAlign) {
                    t.textAlignHorizontal = config.container.textAlign;
                }
            }
            catch (e) {
                // 폰트 로드 실패 시 무시하고 계속
            }
        }
        // 6) container.textAlign === "LEFT" 일 때 — 좌측 정렬 강제
        //    대상: Title/Body/CTA 본인 + 그 안 텍스트 자손 (Title 이 frame 일 때 inner text 들)
        //    처리:
        //      ① 각 레이어 x = 0
        //      ② 각 레이어 본인의 auto-layout (있다면) counterAxisAlignItems = "MIN"
        //         → 안의 자손 텍스트들이 LEFT 로 정렬됨 (Title FRAME 의 inner 두 텍스트 등)
        //      ③ 부모 chain 의 모든 auto-layout 도 counterAxisAlignItems = "MIN"
        //    (banner 자체는 안 건드림)
        if (config.container.textAlign === "LEFT") {
            const layersToAlignSet = new Set();
            for (const n of titleNodes)
                layersToAlignSet.add(n);
            for (const n of titleTexts)
                layersToAlignSet.add(n);
            for (const n of bodyNodes)
                layersToAlignSet.add(n);
            for (const n of bodyTexts)
                layersToAlignSet.add(n);
            if (ctaNode)
                layersToAlignSet.add(ctaNode);
            for (const layer of layersToAlignSet) {
                // ① x = 0
                layer.x = 0;
                // ② 본인의 auto-layout (있다면)
                if ("layoutMode" in layer) {
                    const ly = layer;
                    if (ly.layoutMode && ly.layoutMode !== "NONE") {
                        ly.counterAxisAlignItems = "MIN";
                    }
                }
                // ③ 부모 chain (banner 직전까지)
                let cur = layer.parent;
                while (cur && cur !== banner) {
                    if ("layoutMode" in cur) {
                        const cy = cur;
                        if (cy.layoutMode && cy.layoutMode !== "NONE") {
                            cy.counterAxisAlignItems = "MIN";
                        }
                    }
                    cur = cur.parent;
                }
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
