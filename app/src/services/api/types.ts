/**
 * 协议类型的**唯一来源**已移到 shared/protocol.ts（见该文件顶部说明）。
 *
 * 这里只做转出，好处是 app 内原有的 `./types.js`、`../api/types.js` 导入路径全部不用改，
 * 而网关可以从同一份定义取类型，避免前后端各写一套、协议悄悄漂移。
 */
export * from '../../../../shared/protocol.js'
