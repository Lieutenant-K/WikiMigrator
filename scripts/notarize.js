// @ts-check
const { notarize } = require("@electron/notarize");

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== "darwin") {
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_ID_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.log("Apple 공증 환경변수가 설정되지 않았습니다. 공증을 건너뜁니다.");
    console.log("필요 환경변수: APPLE_ID, APPLE_ID_PASSWORD, APPLE_TEAM_ID");
    return;
  }

  console.log(`공증 시작: ${appName}`);

  await notarize({
    appBundleId: "com.wikimigrator.app",
    appPath: `${appOutDir}/${appName}.app`,
    appleId,
    appleIdPassword,
    teamId,
  });

  console.log("공증 완료!");
};
