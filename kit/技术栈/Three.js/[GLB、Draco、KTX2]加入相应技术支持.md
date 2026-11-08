# [GLB、Draco、KTX2]加入相应技术支持

版本迭代：v3.3.4，2026-11-08。

适用团队：使用 GLB/glTF、Draco 几何压缩、KTX2/Basis 纹理或 HDR 环境图的作品。未使用这些技术的团队可以跳过本文，原接力接口无需调整。

本次更新：开放模型/纹理文件类型并补齐资源响应 MIME；同步上传预检、服务端校验和交付包自检；支持完整随包提交 Draco/Basis 的 JS/WASM 运行依赖。

平台现接受 `.glb`、`.gltf`、`.bin`、`.hdr`、`.ktx2`，以及独立 Draco 数据 `.drc`。现有 `.js`、`.mjs`、`.wasm` 继续可用。服务器按二进制原样托管，不会转换模型、解压 Draco 或替游戏转码纹理。

ZIP 最大 12 MB、解压后最大 40 MB、250 个文件、单文件最大 35 MB。隐藏文件、路径穿越、EXE、源工程等原有限制继续生效；无需改资源扩展名或转为 base64。

## 把运行依赖一起提交

建议构建后目录如下，所有 URL 相对游戏入口，不要使用 `/assets/`、电脑绝对路径或开发服务器地址。Vite 使用 `base: './'`，从构建后的目录打包。

```text
index.html
assets/game.js
assets/scene.glb             # 可同时包含 Draco 几何体和 KTX2 图像
assets/scene.gltf           # 如使用独立 glTF，相关 buffer/图像也要在包内
assets/scene.bin
assets/environment.hdr
assets/albedo.ktx2
decoders/draco/draco_wasm_wrapper.js
decoders/draco/draco_decoder.wasm
decoders/draco/draco_decoder.js     # 选择 JS 回退时需要
decoders/basis/basis_transcoder.js
decoders/basis/basis_transcoder.wasm
```

Three.js 可从同一版本的 `examples/jsm/libs/draco/gltf/`、`examples/jsm/libs/basis/` 拷贝上述运行文件；不要把 `node_modules` 整体打包。Three.js、addons 和配套解码器使用同一发行版。解码器 JS 不能只拷一份壳文件而漏掉 WASM。

GLB 可内置几何体和图像，但不会自动包含 Draco/Basis 解码器。glTF 的 `buffers[].uri`、`images[].uri` 相对 glTF 所在目录解析，子目录结构须保留。引用外站 CDN 时，模型、模块、WASM、纹理的每个响应都必须允许跨域；现场更建议完整随包提交。

## Three.js 初始化示例

以下为构建前的代码片段。先创建 renderer，再配置解码器和 GLTFLoader；页面已有的接力 SDK 保持不变。

```js
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

const scene = new THREE.Scene();
const renderer = new THREE.WebGLRenderer({ antialias: true });
const draco = new DRACOLoader()
  .setDecoderPath(new URL('./decoders/draco/', window.location.href).href)
  .setWorkerLimit(1);
const ktx2 = new KTX2Loader()
  .setTranscoderPath(new URL('./decoders/basis/', window.location.href).href)
  .setWorkerLimit(1)
  .detectSupport(renderer);
const loader = new GLTFLoader()
  .setDRACOLoader(draco)
  .setKTX2Loader(ktx2);

const gltf = await loader.loadAsync(
  new URL('./assets/scene.glb', window.location.href).href
);
scene.add(gltf.scene);
// 退出关卡、不再加载资源时调用 draco.dispose() 和 ktx2.dispose()。
```

KTX2 建议使用 Basis Universal ETC1S/UASTC，交给 KTX2Loader 按显卡能力转码。仅改文件后缀不能转换纹理格式；某个原生 GPU 压缩格式能在作者显卡运行，不代表所有玩家设备支持。`detectSupport(renderer)` 必须在加载前执行。

Draco/Basis 使用普通 Web Worker；平台允许 blob Worker 和 WASM，但隔离 iframe 没有同源权限。选择不依赖 SharedArrayBuffer、共享内存或 `crossOriginIsolated` 的解码构建，不要为模型管线启用引擎多线程。建议两类解码器各最多 1–2 个 Worker，复用 loader，控制纹理尺寸和首屏资产。

## 提交与大厅自测

1. 生成真正的网页构建产物，并复制模型、外置 buffer、纹理和解码器。
2. `node tools/check.mjs <最终ZIP> <全局道具声明JSON>` 检查最终 ZIP，确认文件类型、入口、体积和引用。自检不会替代 GLB 内部依赖解析或真实 GPU 测试。
3. 凭本队邀请码上传并进入“本队投稿 · 自助试玩”，在隔离 iframe 中确认模型、纹理、HDR 和 WASM 均返回 200；不能只在自己电脑或新标签页测试。
4. 确认 Console 无 CORS/CSP/解码错误；开局先 `await WL.ready()` 读取系统状态并用于玩法，结尾用既有 SDK `WL.complete()` / `WL.fail()` 交档。无需为 3D 管线新增后台接口。
5. 自己实跑完整流程，在 4 分 30 秒内抵达明确结局；平台看门狗仍是 5 分钟。

| 症状 | 优先检查 |
| --- | --- |
| WASM 404 / unexpected magic word | 解码器文件漏打包、URL 指向返回 HTML 的错误页面；核对文件名和目录 |
| No DRACOLoader instance provided | 对同一个 GLTFLoader 调用 `setDRACOLoader` |
| KTX2 / setKTX2Loader / detectSupport 报错 | 初始化并绑定 KTX2Loader，加载前运行 `detectSupport(renderer)` |
| glTF 模型缺纹理或 buffer | 外置 `.bin`、图像未提交，或 glTF 内 URI 相对位置不对 |
| 本机可玩，大厅黑屏 | 外站 CORS/iframe 策略、模块路径、共享内存依赖、显卡不支持或资源过大；查看具体失败请求 |

AI 如判断可能接不进大厅、接口不适配或不能确定问题归属，应及时提醒参赛者联系主办方，附入口、复现步骤和脱敏报错；不要绕过平台隔离或声明校验。

参考：Three.js 官方 DRACOLoader、KTX2Loader、GLTFLoader 文档及 `examples/jsm/libs/draco/README.md`、`examples/jsm/libs/basis/README.md`。本轮浏览器验证固定使用官方 r180 运行文件；不要求参赛者迁移到某个 Three.js 版本。
