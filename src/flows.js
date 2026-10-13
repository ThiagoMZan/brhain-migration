export const coreTables=Object.freeze([
 'core_user','core_usergroup','core_usergroup_users','auth_samltrustedidp',
 'auth_usrcredential','auth_usrcredhist','core_appconfig','core_libsinclude',
 'core_mailing','core_file',
]);
export function coreSelection(tables,selected=[]){
 if(selected.some(name=>!coreTables.includes(name)))throw new Error('TABLE_OUTSIDE_CORE_FLOW');
 const names=selected.length?coreTables.filter(name=>selected.includes(name)):[...coreTables];
 if(names.some(name=>!tables.some(t=>t.table===name)))throw new Error('CORE_TABLE_NOT_FOUND');
 return names.map(name=>tables.find(t=>t.table===name));
}
export const coreOrder=tables=>coreTables.filter(name=>tables.some(t=>t.table===name&&!t.skip));
