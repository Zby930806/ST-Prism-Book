# 发布与安装

文件名沿用旧名，以免已有链接失效。仓库按维护者的决定公开。

## 上传到仓库

可通过 git 推送或网页上传。要求：

1. 仓库根目录直接包含 manifest.json、README.md、src、dist 等；dist 中包含 index.js、index.css 和 index.js.map。
2. 源码、dist 和 manifest 版本必须一致，不能只上传源码。
3. 不上传聊天、settings.json、.env、密钥、node_modules、备份和本机验证记录，也不能只上传一个 ZIP。
4. 仓库统一用 LF 换行（.gitattributes），各系统检出后构建出的 dist 一致；pnpm-workspace.yaml 允许 esbuild 的安装脚本。
5. 提交前检查文件列表。`pnpm release:check` 检查版本是否一致、dist 是否由当前源码构建（逐个比较 dist/index.js.map 中的源码与当前 src 文件，统一换行后比较）、更新说明是否已构建、docs/prompts 是否与源码重新导出的结果一致，以及根目录是否有多余文件、是否有疑似密钥。改了源码要先 `pnpm build`，改了提示词要先 `pnpm export:prompts`；构建和导出方面的问题一次列出。
6. 每次发布同时推送 GitHub 和码云镜像：`git push origin main` 后 `git push gitee main`（gitee 远程为 https://gitee.com/ljbs1106/ST-Prism-Book.git，第一次推送时按提示登录码云账号）。国内用户从码云安装和更新，镜像没跟上时他们收不到新版本。推送后打开 https://gitee.com/api/v5/repos/ljbs1106/ST-Prism-Book/contents/manifest.json ，把返回的 content（base64）解码，核对版本号是新版本。

## 安装和更新

在酒馆扩展面板中点击「安装扩展」，填入仓库地址：https://github.com/Zby930806/ST-Prism-Book ，国内网络填码云镜像 https://gitee.com/ljbs1106/ST-Prism-Book 。插件启动时请酒馆对安装目录执行 git fetch（/api/extensions/version），落后于安装来源时，打开宝书弹出更新窗口；确认后调用酒馆的扩展更新接口（/api/extensions/update，即 git pull），成功后自动刷新页面。更新窗口里的版本号和说明由浏览器读取安装来源的 manifest.json 和 README 中「X.Y.Z 的改动」一节，所以每次发布都要在 README 写这一节；依次读安装来源所在的网站（GitHub 原始文件或码云接口）、另一条线路、jsDelivr。码云的原始文件地址不允许网页跨域读取，用的是 contents 接口（匿名每小时 60 次）。推送后清一次 jsDelivr 的缓存（依次打开 https://purge.jsdelivr.net/gh/Zby930806/ST-Prism-Book@main/README.md 与同一路径下的 manifest.json，返回的 JSON 中 status 为 finished 即可），否则 12 小时内读到的可能还是旧说明。在宝书里更新并刷新后，插件从本机新装好的 README 列出这次更新的内容。也可以在「管理扩展」中更新。manifest 中 auto_update 为 true：打开酒馆的「在扩展更新时通知」后，有新版本时酒馆会提示；酒馆自身升级时按酒馆设置顺带更新本扩展。更新只从本扩展的安装来源拉取；安装来源是原版仓库时插件不提示、不更新，插件自身不访问原版的更新源。手动安装见 README。原版和本版共用同一份数据、宏和事件，不能同时启用。

酒馆的 git fetch 失败（返回 5xx）或 60 秒没有结果时，插件从报错里认出安装来源；是本扩展的 GitHub 仓库或码云镜像（认不出时按 GitHub 算）时，由浏览器读另一条线路上的版本号，有新版本就在更新窗口里提供「改从码云安装」（从码云安装的则改从 GitHub）。改用线路时浏览器先读目标线路的 manifest.json，读不到或比当前旧就不动现有安装；然后请酒馆删除安装目录（/api/extensions/delete），再从目标线路的地址安装（/api/extensions/install，即 git clone），完成后自动刷新。设置页底部显示当前线路，可以随时改用另一条。

接续旧聊天前参阅 [旧记忆接续说明](LEGACY-COMPATIBILITY.md)：已知的 V3 格式直接读取，可确定对应关系的 V2 格式在本地转换，无法识别的格式只读保护。升级无需全部重新摘要。

「全部重新摘要」（1.4.2 之前叫「重建本聊天记忆」）保留，但不会自动执行：需手动确认，执行时按楼层顺序请求模型，可能产生费用，并替换已有摘要和模型记录的状态；各页面的手动修改单独保存，完成后保留。取消、失败或刷新页面后可以从停下的楼层继续。使用前先备份。

## 不做的事

不使用上游的一键更新（插件内的更新只拉取本扩展的安装来源），不提供 GitHub Pages、自动 Release 或自动部署。package.json 中的 private: true 仅用于防止误发布到 npm，与仓库是否公开无关。

公开仓库中不放置授权聊天截图、私人联系方式或令牌。
