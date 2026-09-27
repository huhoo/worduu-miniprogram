# 上传笔顺分片到云存储

`tools/strokes/` 下有 99 个 JSON 分片，共 7.1MB。它们是笔顺动画的数据源，
**不上传就没有笔顺动画**（页面会如实显示「暂无笔顺数据」，不会报错）。

它们不进小程序包（`project.config.json` 的 `packOptions.ignore` 已排除整个 `tools/`），
只能放云存储按需拉取。

---

## 路径要对得上

云存储里的路径必须落在 `utils/config.js` 的 `strokePrefix` 下，默认是 `strokes/`：

```
strokes/4e.json
strokes/9f.json
...
```

文件名保持原样，不要改名 —— 前端是按「字的 Unicode 码点高位」直接拼文件名去取分片的。

---

## 方法一：云开发控制台（不用装东西）

1. 微信开发者工具 → 云开发 → 存储
2. 新建文件夹 `strokes`
3. 进 `strokes`，点「上传文件」，全选本地 `tools/strokes/` 下的 99 个 `.json`

> 控制台一次多选 99 个通常没问题。如果被限制数量，分 3~4 批传，
> 每批传完刷新看一眼数量对不对。

## 方法二：cloudbase CLI（更快，适合重传）

```bash
npm i -g @cloudbase/cli
tcb login                      # 会打开浏览器授权
tcb storage upload -e <环境ID> tools/strokes/ strokes/ --dir
```

`--dir` 表示整个目录上传。99 个文件约 7MB，一般一两分钟传完。

---

## 传完还要配一个环境变量

云函数读分片需要知道完整的 fileID 前缀，它**猜不出 bucket**（那段 `636c-xxx-1301234567`
是平台分配的）。传完以后：

1. 在存储列表里点开任意一个分片，复制它的**文件 ID**
2. 去掉末尾的 `/4e.json`
3. 把剩下的部分填进云函数 `ziban` 的环境变量 `STROKE_FILE_PREFIX`
4. **重新部署**云函数才会生效

详见 `LAUNCH.md` 阶段 2.3 / 2.5（那里还写了怎么用云端测试验证 `stroke-data` 返回非空）。

---

## 传完怎么验证

在云开发控制台的存储列表里确认：

- [ ] `strokes/` 下是 **99 个**文件（不是 98 也不是 100）
- [ ] 随便点开一个 `4e.json`，能看到 `{"一":{"m":[...],"n":[...]}}` 这样的结构
  - `m` 是中心线（笔画几何），`n` 是笔画名
  - 只有 `m` 没有 `n` 也能动画，只是不显示笔画名

然后在真机上打开任一汉字的笔顺页：能看到逐笔动画就说明通了。
看不到动画但也不报错，多半是路径或文件名对不上。

---

## 什么时候需要重传

上游 Web 版更新了笔画数据后，本地要先跑一次：

```bash
node tools/update-stroke-shards.mjs   # 只刷新 n 字段，m 不动
```

然后**重新上传这 99 个分片** —— 云上的数据不会自动跟着本地变。
另外别忘了一并重新生成随包数据表：

```bash
node tools/build-cnchar-strokes.mjs
```
