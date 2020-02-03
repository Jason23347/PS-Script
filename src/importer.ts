/// <reference path="legacy.d.ts" />
/// <reference path="custom_options.ts" />
/// <reference path="common.ts" />
/// <reference path="text_parser.ts" />

namespace LabelPlus {

// global var
let opts: CustomOptions | null = null;
let errorMsg: string = ""; // error message collection, shown after all done

interface Group {
    layerSet?: LayerSet;
    templete?: ArtLayer;
};
type GroupDict = { [key: string]: Group };

type ArtLayerDict = { [key: string]: ArtLayer };

interface LabelInfo {
    index: number;
    x: number;
    y: number;
    group: string;
    contents: string;
};

interface ImageWorkspace {
    doc: Document;

    bgLayer: ArtLayer;
    textTempleteLayer: ArtLayer;
    dialogOverlayLayer: ArtLayer;

    pendingDelLayerList: ArtLayerDict;
    groups: GroupDict;
};

interface ImageInfo {
    ws: ImageWorkspace;
    name: string;
    labels: LpLabel[];
};

function importLabel(img: ImageInfo, label: LabelInfo): boolean
{
    assert(opts !== null);

    // import the index of the Label
    if (opts.outputLabelNumber) {
        let o: TextInputOptions = {
            templete: img.ws.textTempleteLayer,
            direction: Direction.HORIZONTAL,
            font: "Arial",
            size: (opts.fontSize !== 0) ? UnitValue(opts.fontSize, "pt") : undefined,
            lgroup: img.ws.groups["_Label"].layerSet,
        };
        newTextLayer(img.ws.doc, String(label.index), label.x, label.y, o);
    }

    // 替换文本
    if (opts.textReplace) {
        let textReplace: any = textReplaceReader(opts.textReplace); //todo: 应该在上层直接完成替换
        for (let k = 0; k < textReplace.length; k++) {
            while (label.contents.indexOf(textReplace[k].From) != -1)
                label.contents = label.contents.replace(textReplace[k].From, textReplace[k].To);
        }
    }

    // 确定文字方向
    let textDir: Direction | undefined;
    switch (opts.textDirection) {
    case OptionTextDirection.Keep:       textDir = undefined; break;
    case OptionTextDirection.Horizontal: textDir = Direction.HORIZONTAL; break;
    case OptionTextDirection.Vertical:   textDir = Direction.VERTICAL; break;
    }

    // 导出文本，设置的优先级大于模板，无模板时做部分额外处理
    let textLayer: ArtLayer;
    let o: TextInputOptions = {
        templete: img.ws.groups[label.group].templete,
        font: (opts.font != "") ? opts.font : undefined,
        direction: textDir,
        lgroup: img.ws.groups[label.group].layerSet,
        lending: opts.textLeading ? opts.textLeading : undefined,
    };

    // 使用模板时，用户不设置字体大小，不做更改；不使用模板时，如果用户不设置大小，自动调整到合适的大小
    if (opts.docTemplete === OptionDocTemplete.No) {
        let proper_size = UnitValue(min(img.ws.doc.height.as("pt"), img.ws.doc.height.as("pt")) / 90.0, "pt");
        o.size = (opts.fontSize !== 0) ? UnitValue(opts.fontSize, "pt") : proper_size;
    } else {
        o.size = (opts.fontSize !== 0) ? UnitValue(opts.fontSize, "pt") : undefined;
    }
    textLayer = newTextLayer(img.ws.doc, label.contents, label.x, label.y, o);

    // 执行动作,名称为分组名
    if (opts.runActionGroup) {
        try {
            img.ws.doc.activeLayer = textLayer;
            this.doAction(label.group, opts.runActionGroup);
        }
        catch (e) {
            Stdlib.log("DoAction " + label.group +
                " in " + opts.runActionGroup +
                " Error: \r\n" + e);
        }
    }
    return true;
}

function importImage(img: ImageInfo): boolean
{
    assert(opts !== null);

    // 文件打开时执行一次动作"_start"
    if (opts.runActionGroup) {
        img.ws.doc.activeLayer = img.ws.doc.layers[img.ws.doc.layers.length - 1];
        try { doAction("_start", opts.runActionGroup); }
        catch (e) { }
    }

    // 找出需要涂白的标签,记录他们的坐标,执行涂白
    if (opts.overloayGroup) {
        let points = new Array();
        for (let j = 0; j < img.labels.length; j++) {
            let l = img.labels[j];
            if (l.group == opts.overloayGroup) {
                points.push({ x: l.x, y: l.y });
            }
        }
        MyAction.lp_dialogClear(points, img.ws.doc.width, img.ws.doc.height, 16, 1, img.ws.dialogOverlayLayer);
        delete img.ws.pendingDelLayerList[TEMPLETE_LAYER.DIALOG_OVERLAY]; // 不删除涂白图层
    }

    // 遍历LabelData
    for (let j = 0; j < img.labels.length; j++) {
        let l = img.labels[j];
        if (opts.groupSelected.indexOf(l.group) == -1) // the group did not select by user, return directly
            continue;

        let label_info: LabelInfo = {
            index: j + 1,
            x: l.x,
            y: l.y,
            group: l.group,
            contents: l.contents,
        };
        importLabel(img, label_info);
    }

    // 调整图层顺序
    if (img.ws.bgLayer && (opts.overloayGroup !== "")) {
        // 涂白图层 在 bg层之上
        //todo: 未处理打开文件为psd/tiff的情况，考虑将这类文件中的所有图层放到一个分组里，来实现排序
        img.ws.dialogOverlayLayer.move(img.ws.bgLayer, ElementPlacement.PLACEBEFORE);
    }

    // 删除多余的图层、分组
    for (let k in img.ws.pendingDelLayerList) { // 删除模板中无用的图层
        img.ws.pendingDelLayerList[k].remove();
    }
    for (let k in img.ws.groups) { // 删除分组LayerSet
        if (img.ws.groups[k].layerSet !== undefined) {
            if (img.ws.groups[k].layerSet?.artLayers.length === 0) {
                img.ws.groups[k].layerSet?.remove();
            }
        }
    }

    // 文件关闭时执行一次动作"_end"
    if (opts.runActionGroup) {
        try {
            img.ws.doc.activeLayer = img.ws.doc.layers[img.ws.doc.layers.length - 1];
            this.doAction("_end", opts.runActionGroup);
        }
        catch (e) { }
    }
    return true;
}

function openImageWorkspace(img_filename: string, templete_path: string): ImageWorkspace | null
{
    assert(opts !== null);

    let doc: Document;
    let bgLayer: ArtLayer;
    let textTempleteLayer: ArtLayer;
    let dialogOverlayLayer: ArtLayer;
    let pendingDelLayerList: ArtLayerDict = {};

    // 打开图片文件
    let bgFile = new File(opts.source + dirSeparator + img_filename);
    if (!bgFile || !bgFile.exists) {
        return null;
    }

    // 在PS中打开图片文件，如果是PS专用格式（PSD/TIFF）则直接打开；否则根据配置使用PSD模板或新建PSD，再将图片导入为bg图层
    let file_type: string = getFileSuffix(img_filename);
    if ((file_type == ".psd") || (file_type == ".tif") || ((file_type == ".tiff"))) {
        return null; //todo: 暂时不支持专用格式，待修复

        try { doc = app.open(bgFile); }
        catch (e) {
            return null; //note: do not exit if image not exsit
        }
    }
    else {
        let bg: Document;
        try { bg = app.open(bgFile); }
        catch (e) {
            return null; //note: do not exit if image not exsit
        }
        bg.selection.selectAll();
        bg.selection.copy();

        if (opts.docTemplete == OptionDocTemplete.No) {
            doc = app.documents.add(bg.width, bg.height, bg.resolution, bg.name, NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
            doc.activeLayer.name = TEMPLETE_LAYER.IMAGE;
        } else {
            let docFile = new File(templete_path);  //note: templete must exsit, if not, just let it crash
            doc = app.open(docFile);
            doc.resizeImage(undefined, undefined, bg.resolution);
            doc.resizeCanvas(bg.width, bg.height);
        }
        // 将模板中所有图层加入待删除列表
        for (let i = 0; i < doc.artLayers.length; i++) {
            let layer: ArtLayer = doc.artLayers[i];
            pendingDelLayerList[layer.name] = layer;
        }

        // 选中bg图层，将图片粘贴进去
        bgLayer = doc.artLayers.getByName(TEMPLETE_LAYER.IMAGE);
        doc.activeLayer = bgLayer;
        doc.paste();
        bg.close(SaveOptions.DONOTSAVECHANGES);
        delete pendingDelLayerList[TEMPLETE_LAYER.IMAGE]; // keep bg layer
    }

    // 寻找文本模板，即名为text的图层；若text图层不存在，复制一个文本图层，若文本图层不存在，直接创建一个
    try { textTempleteLayer = doc.artLayers.getByName(TEMPLETE_LAYER.TEXT); }
    catch {
        Stdlib.log("text templete layer not found, copy one.");
        for (let i = 0; i < doc.artLayers.length; i++) {
            let layer: ArtLayer = <ArtLayer> doc.artLayers[i];
            if (layer.kind == LayerKind.TEXT) {
                /// @ts-ignore ts声明文件有误，duplicate()返回ArtLayer对象，而不是void
                textTempleteLayer = <ArtLayer> layer.duplicate();
                textTempleteLayer.textItem.contents = TEMPLETE_LAYER.TEXT;
                textTempleteLayer.name = TEMPLETE_LAYER.TEXT;

                pendingDelLayerList[TEMPLETE_LAYER.TEXT] = layer; // 导入完成后删除该图层
                break;
            }
        }
        if (textTempleteLayer! !== undefined) {
            textTempleteLayer = doc.artLayers.add();
            textTempleteLayer.name = TEMPLETE_LAYER.TEXT;
            pendingDelLayerList[TEMPLETE_LAYER.TEXT] = textTempleteLayer; // 导入完成后删除该图层
        }
        assert(textTempleteLayer! !== undefined);
    }

    // 确定涂白模板
    try { dialogOverlayLayer = doc.artLayers.getByName(TEMPLETE_LAYER.DIALOG_OVERLAY); }
    catch {
        dialogOverlayLayer = doc.artLayers.add();
        dialogOverlayLayer.name = TEMPLETE_LAYER.DIALOG_OVERLAY;
    }

    // 若文档类型为索引色模式 更改为RGB模式
    if (doc.mode == DocumentMode.INDEXEDCOLOR) {
        doc.changeMode(ChangeMode.RGB);
    }

    // 分组
    let groups: GroupDict = {};
    for (let i = 0; i < opts.groupSelected.length; i++) {
        let name = opts.groupSelected[i];
        let tmp: Group = {};

        // 创建PS中图层分组
        if (!opts.layerNotGroup) {
            tmp.layerSet = doc.layerSets.add();
            tmp.layerSet.name = name;
        }
        // 尝试寻找分组模板，找不到则使用默认文本模板
        if (opts.docTemplete !== OptionDocTemplete.No) {
            let l: ArtLayer | undefined;
            try {
                l = doc.artLayers.getByName(name);
            } catch { };
            tmp.templete = (l !== undefined) ? l : textTempleteLayer;
        }
        groups[name] = tmp; // add
    }
    if (opts.outputLabelNumber) {
        let tmp: Group = {};
        tmp.layerSet = doc.layerSets.add();
        tmp.layerSet.name = "Label";
        groups["_Label"] = tmp;
    }

    let ws: ImageWorkspace = {
        doc: doc,
        bgLayer: bgLayer,
        textTempleteLayer: textTempleteLayer,
        dialogOverlayLayer: dialogOverlayLayer,
        pendingDelLayerList: pendingDelLayerList,
        groups: groups,
    };
    return ws;
}

function closeImage(img: ImageInfo): boolean
{
    assert(opts !== null);

    // 保存文件
    let fileOut = new File(opts.target + "//" + img.name);
    let options = PhotoshopSaveOptions;
    let asCopy = false;
    let extensionType = Extension.LOWERCASE;
    img.ws.doc.saveAs(fileOut, options, asCopy, extensionType);

    // 关闭文件
    if (!opts.notClose)
        img.ws.doc.close();

    return true;
}

export function importFiles(custom_opts: CustomOptions): boolean
{
    opts = custom_opts;

    Stdlib.log.setFile(opts.labelFilePath + dirSeparator + "LabelPlusInputer.log");//LabelPlusInputOptions.LOG_FILE);
    Stdlib.log("Start");
    Stdlib.log("Properties:");
    Stdlib.log(Stdlib.listProps(opts));

    //解析LabelPlus文本
    let lpFile = lpTextParser(opts.labelFilename);
    if (lpFile == null) {
        let errmsg = "error: " + i18n.ERROR_READLABELTEXTFILEFAILL;
        Stdlib.log(errmsg);
        alert(errmsg);
        return false;
    }

    // 确定doc模板文件
    let templete_path: string = "";
    switch (opts.docTemplete) {
    case OptionDocTemplete.Custom:
        templete_path = opts.docTempleteCustomPath;
        break;
    case OptionDocTemplete.Auto:
        let tempdir = GetScriptFolder() + dirSeparator + "ps_script_res" + dirSeparator;
        let tempname = app.locale.split("_")[0].toLocaleLowerCase() + ".psd"; // such as "zh_CN" -> zh.psd

        let try_list: string[] = [
            tempdir + tempname,
            tempdir + "en.psd"
        ];
        for (let i = 0; i < try_list.length; i++) {
            if (FileIsExists(try_list[i])) {
                templete_path = try_list[i];
                break;
            }
        }
        if (templete_path === "") {
            let errmsg = "error: " + i18n.ERROR_NotAutoMatchTemplete;
            Stdlib.log(errmsg);
            throw errmsg;
        }
        break;
    default:
    }

    // 遍历所选图片
    let originFileList = getFilesListOfPath(opts.source); //读取图源文件夹文件列表
    for (let i = 0; i < opts.imageSelected.length; i++) {
        let originName :string = opts.imageSelected[i].file; // 翻译文件中的图片文件名
        let filename: string;

        if (!opts.outputNoSignPsd && lpFile?.images[originName].length == 0) // 不处理无标号文档
            continue;

        // 根据sourceFileType替换文件后缀名 && 忽略原始图片名
        if (opts.sourceFileType) {
            filename = originName.substring(0, originName.lastIndexOf(".")) + opts.sourceFileType;
        }
        else if (opts.ignoreImgFileName) {
            filename = originFileList[opts.imageSelected[i].index];
        }
        else {
            filename = originName;
        }

        Stdlib.log("open file: " + filename);
        let ws = openImageWorkspace(filename, templete_path);
        if (ws == null) { // error, ignore
            let msg = filename + ": open file failed";
            Stdlib.log(msg);
            errorMsg = errorMsg + msg + "\r\n";
            continue;
        }

        let img_info: ImageInfo = {
            ws: ws,
            name: filename,
            labels: lpFile.images[originName],
        };
        if (!importImage(img_info)) {
            let msg = filename + ": import label failed";
            Stdlib.log(msg);
            errorMsg = errorMsg + msg + "\r\n";
        }
        if (!closeImage(img_info)) {
            let msg = filename + ": save/close file failed";
            Stdlib.log(msg);
            errorMsg = errorMsg + msg + "\r\n";
        }
        Stdlib.log("complete file: " + filename);
    }
    alert(i18n.COMPLETE);
    if (errorMsg != "") {
        alert("error:\r\n" + errorMsg);
    }
    Stdlib.log("Complete!");
    return true;
};


// 文本导入选项，参数为undefined时表示不设置该项
interface TextInputOptions {
    templete?: ArtLayer;     // 文本图层模板
    font?: string;
    size?: UnitValue;
    direction?: Direction;
    lgroup?: LayerSet;
    lending?: number;        // 自动行距
};

// 创建文本图层
function newTextLayer(doc: Document, text: string, x: number, y: number, topts: TextInputOptions = {}): ArtLayer
{
    let artLayerRef: ArtLayer;
    let textItemRef: TextItem;

    // 从模板创建，可以保证图层的所有格式与模板一致
    if (topts.templete) {
        /// @ts-ignore ts声明文件有误，duplicate()返回ArtLayer对象，而不是void
        artLayerRef = <ArtLayer> topts.templete.duplicate();
        textItemRef = artLayerRef.textItem;
    }
    else {
        artLayerRef = doc.artLayers.add();
        artLayerRef.kind = LayerKind.TEXT;
        textItemRef = artLayerRef.textItem;
    }

    if (topts.size)
        textItemRef.size = topts.size;

    if (topts.font)
        textItemRef.font = topts.font;

    if (topts.direction)
        textItemRef.direction = topts.direction;

    textItemRef.position = Array(UnitValue(doc.width.as("px") * x, "px"), UnitValue(doc.height.as("px") * y, "px"));

    if (topts.lgroup)
        artLayerRef.move(topts.lgroup, ElementPlacement.PLACEATBEGINNING);

    if ((topts.lending) && (topts.lending != 0)) {
        textItemRef.useAutoLeading = true;
        textItemRef.autoLeadingAmount = topts.lending;
    }

    artLayerRef.name     = text;
    textItemRef.contents = text;

    return artLayerRef;
}

//
// 文本替换字符串解析程序
//
function textReplaceReader(str: string)
{
    let arr = new Array();
    let strs = str.split('|');
    if (!strs)
        return; //解析失败

    for (let i = 0; i < strs.length; i++) {
        if (!strs[i] || strs[i] == "")
            continue;

        let strss = strs[i].split("->");
        if ((strss.length != 2) || (strss[0] == ""))
            return; //解析失败

        arr.push({
            From: strss[0],
            To: strss[1],
        });
    }

    if (arr.length != 0)
        return arr;
    else
        return;
}

} // namespace LabelPlus