# DSH VS Code Workspace Launcher

在 DeepSeek Harness 的会话右上角「…」菜单，悬停 **打开 VS Code 工作区** 展开侧边子菜单。第一项 **打开当前工作区文件夹** 在 VS Code 打开已注册目录；其余项打开对应的 `.code-workspace` 文件，显示相对于该目录的路径。键盘也可打开此子菜单。

插件独立注册菜单项，不会修改原生「在应用中打开」；在 DSH 0.2.2-rc.5 中，菜单项位于「在应用中打开」之后。

在「插件 → dsh-vscode-workspace-launcher」的设置卡可调整 **搜索深度**（0–8，默认 2）。0 只查工作区根目录，1 也查一级子目录，2 也查二级子目录。

## 安装

用 DSH 0.2.2-rc.5、Node.js 24.9.0+。桌面端在「插件 → 添加插件」填写 `github:Sth32/dsh-vscode-workspace-launcher`，安装后启用并按提示重启。Web 可运行：

```sh
dsh plugin --profile web add github:Sth32/dsh-vscode-workspace-launcher
```

如需从本地包安装，先在源码目录执行 `npm pack`，再运行：

```sh
dsh plugin --profile web add /absolute/path/dsh-vscode-workspace-launcher-0.1.1.tgz
```

重启对应 DSH 配置。如果使用其他 DSH profile，把命令里的 `web` 换成对应名称。已在 Linux 的 DSH Web 0.2.2-rc.5 + VS Code 1.147.0 验证安装、真实菜单、搜索深度保存和两种打开路径：「打开当前工作区文件夹」打开已注册目录；点文件后，VS Code Explorer 显示该文件配置的工作区根。Linux/macOS 会从可信的宿主安装目录或启动时原有 PATH 查找 `code`；Windows 查找常规安装目录或 PATH 上的 `Code.exe`（不经 shell 执行 `code.cmd`）。

## 范围

只扫描当前会话关联的已注册目录，从根目录逐层扫描至配置深度，最多 4,000 个条目或 100 个结果；跳过 Git、node_modules 及符号链接。扫描被截断时菜单会提示。不会读取工作区文件内容或改变 DSH 工作区、权限、会话、首选编辑器；VS Code 自行处理工作区文件内容和 Workspace Trust。宿主必须在本机运行，并由 DSH 的所有者连接授权；不支持 SSH 模式或远程浏览器访问。请只打开可信的工作区文件。

## 0.1.1

- 根目录和近层子目录先扫描，默认深度为 2，可在插件设置中调整。
- 使用 DSH 原生侧边子菜单，扫描未完成时会明确提示，仍可选择打开目录。

## 开发

在源码目录运行 `npm test`。测试使用临时目录和替身编辑器，不需要模型额度。

## 许可证

[MIT](LICENSE)。本插件由社区维护，与 DeepSeek 和 Microsoft 无隶属关系。
