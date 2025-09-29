// src/handlers/index.ts
export { handleProfile }   from "./profile.js";
export { handleMyProfile } from "./myprofile.js";
export { handlePhotos }    from "./photos.js";
export { handleTags }      from "./tags.js";
export { handleLocation }  from "./location.js";
export { handleBrowse }    from "./browse.js";
export { handleSettings }  from "./settings.js";
// kein handleAi – KI-Start ist lokal in bot.ts
export { handleDeleteMe }  from "./deleteme.js";
export { handleCancel }    from "./cancel.js";
export { handleAdmin }     from "./admin.js";
