# 维护手册（本 fork 自用）

> 这是 [tonyzdev/dsh-session-messaging](https://github.com/tonyzdev/dsh-session-messaging) 的个人 fork。上游解决「消息怎么送到」，本 fork 加了任务合同、看门狗、归档三件事。
> 给维护会话看的：一次改动要经过哪些步骤、哪些边界不能破、哪里还没验证。

## 一、项目由四样东西组成

| 物件 | 位置 | 作用 | 丢了的后果 |
|---|---|---|---|
| 插件源码 | 本仓库根 | 五个工具、账本、看门狗 | 中枢失去派活与回执能力 |
| 安装 | desktop profile 的 `package.json` 用 `link:<仓库根>` | 让 DSH 加载本地这份代码 | 「插件」页里消失 |
| 中枢 skill | `~/.dsh/skills/hub-ops`（软链到 magpie 技能库 `library/skills/hub-ops`） | 中枢的操作手册 | 中枢退回凭印象调度 |
| 任务账本 | `$DSH_HOME/session-tasks/` | 每任务一份 JSONL + 人看的 `board.md` | 任务历史丢失（会话本身不受影响） |

四者里只有前两个在 git 里；skill 由 magpie 管理，账本是本机数据，不要提交。

## 二、一次改动的标准流程

```sh
node --test test/*.test.js        # 改完先跑，51 条基线
# 改 package.json 的 version
git add -A && git commit -m "..." && git push origin main
```

然后到 DSH「插件」页把 `@tonyzdev/dsh-session-messaging` **关掉再打开**——`lib/index.js` 的宿主代码不热替换。只改了 `lib/client.js` 时，还要重新安装并刷新页面。

**验证方式**：新开一个会话，能调用 `session_tasks` 就是装好了；让它 `session_archive` 一个空会话，能看到「退役检查」那段文字就是新版本。

## 三、三条不能破的边界

改动前先读这三行，越过任何一条都会让机制自相矛盾。

1. **谁持有任务，只由 `dispatch` / `takeover` 决定。** 别让 `report` 事件改写 `state.by`——那样看门狗会把通知发回工人自己。
2. **投递失败和账本写失败必须分开。** 消息已经进了对方收件箱、账本写不进去时，只能 warn，不能报错；报错会让发送方重试并投两遍。反之，没投出去就不能记账。
3. **看门狗永不重派 `running` 的会话。** 这条是单写者锁的对称面，破了就是两个会话干同一件事。

## 四、还没验证 / 已知限制

- `session_archive` 真正归档的路径**只在单测里跑过**，没在真实会话上执行过。第一次用要盯返回：失败会明确报错，不会误删。
- 绿点（未读点）是 DSH 客户端内存状态，插件碰不到；只能靠归档让行消失。上游记录：[#9046](https://github.com/deepseek-ai/deepseek-harness/discussions/9046)、[#12271](https://github.com/deepseek-ai/deepseek-harness/discussions/12271)。
- `board.md` 每记一笔就全量重算：50 任务约 13 ms，500 约 74 ms。任务多了删掉已结束的 JSONL 即可。
- 合同是软约束：模型不按格式回报时不会追问，只在 `session_tasks` 里显示「第 N 轮、没有回执」。

## 五、同步上游

```sh
git fetch upstream
git merge upstream/main
node --test test/*.test.js
git push origin main
```

冲突基本只在 `lib/index.js` 的 `relayContent`（多了任务上下文块）和工具注册处；`lib/tasks.js` 是新增文件，不参与合并。

## 六、版本历史

| 版本 | 内容 |
|---|---|
| 0.4.0 | 任务合同：单写者、已完成自动带入、回执 |
| 0.5.0 / 0.5.1 | 看门狗：无回执 25 分钟自动重派，2 次后停手；修 report 覆盖派活方、账本写失败误报投递失败 |
| 0.6.0 / 0.6.1 | `session_archive`（归档/恢复）+ 退役检查 `confirm` 门槛 |