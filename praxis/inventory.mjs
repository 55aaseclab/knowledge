import { join } from 'node:path';
export function projectInventory({id,config,working,workspaceId,storage,reminderSpaces,slidesSpaces,polaris,financeMounts,financeProjectName,intelligenceRuntime,locations,add,file,source,safePath,paths,object}) {

      if (safePath(config.dataDir)) file('笔记与版本', 'sqlite', join(config.dataDir, `${id}.db`));
    if (!working) {
      source('发布基线文档', 'src/content/docs', '原稿属于版本化源码；受控编辑与历史版本在上方数据库中。');
      source('发布图片与参考页面', 'public');
    }
}
