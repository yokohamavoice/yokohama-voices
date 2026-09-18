import project from "@/data/project.json";
export const CREATOR_NAME = project.creator;
export const DATA_REPOSITORY = /^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(project.githubRepository) ? `https://github.com/${project.githubRepository}` : null;
export const CONTACT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(project.contactEmail) ? project.contactEmail : null;
export const NOTICE_VERSION = "research-notice-2026-09-18-contact-v4";
export const DATA_NOTICE = "投稿・回答や意見の表示履歴は、研究や分析結果の公表に使うことがあります。確認を終えた投稿と回答データはGitHubで公開します。氏名や連絡先は書かないでください。";
