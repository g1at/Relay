(function(root) {
  'use strict';
  const paths = {
    folder:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    folderOpen:'<path d="M3 10V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v1"/><path d="M3 10h17a1 1 0 0 1 .94 1.34l-2.5 7A1 1 0 0 1 17.5 19H4a2 2 0 0 1-2-2V10Z"/>',
    file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6"/>',
    goal:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="m12 12 9-9m-4 0h4v4"/>',
    plan:'<path d="M9 18h6m-5 3h4M8.1 14.5A6 6 0 1 1 16 14.5c-.8.7-1 1.5-1 2.5H9c0-1-.2-1.8-.9-2.5ZM12 1v2M2 11h2m16 0h2"/>',
    plus:'<path d="M12 5v14M5 12h14"/>', chevron:'<path d="m9 6 6 6-6 6"/>',
    check:'<path d="m5 12 4 4L19 6"/>', more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    edit:'<path d="m15 5 4 4M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4 15z"/>', close:'<path d="m6 6 12 12M6 18 18 6"/>',
    skill:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>', back:'<path d="m14 6-6 6 6 6"/>', search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.folder}</svg>`;
  function create(options) {
    const { api, context, selectProject, newConversation, setMode, addFiles, notify, refreshHistory, prompt, confirm } = options;
    const attach=document.getElementById('btnAttach'), projectButton=document.getElementById('btnProjectContext'), modeButton=document.getElementById('btnExecutionMode');
    const inputCard=document.getElementById('inputCard'), input=document.getElementById('input');
    let projects=[], menu=null, anchor=null, revision=0, menuRevision=0, menuBack=null;
    const historyContainer=document.getElementById('historyList');
    const measureProjectName=name=>name.classList.toggle('is-overflowing',name.clientWidth>0&&name.scrollWidth>name.clientWidth+1);
    const measureProjectNames=()=>historyContainer.querySelectorAll('.project-name span').forEach(measureProjectName);
    // Observe the container rather than individual rows, so removed projects are
    // not retained. Sidebar dragging updates the fade at the actual text edge.
    const projectNameObserver=typeof ResizeObserver==='function'?new ResizeObserver(()=>{measureProjectNames();position();}):null;
    projectNameObserver?.observe(historyContainer);
    projectNameObserver?.observe(inputCard);
    const collapsed = new Set();
    try { for (const id of JSON.parse(localStorage.getItem('relay.projects.collapsed') || '[]')) collapsed.add(id); } catch (_) {}
    const project = id => projects.find(item => item.id===id);
    async function refresh({quiet=false,throwOnError=false}={}) {
      const own=++revision;
      try {
        const response=await api.projects.list();
        if (own!==revision) return projects;
        if (response && response.ok===false) throw Error(response.error);
        projects=Array.isArray(response && response.projects)?response.projects:[];
        sync(); return projects;
      } catch(error) { if(!quiet)notify(error.message || '项目加载失败');if(throwOnError)throw error;return projects; }
    }
    function sync() {
      const current=context(), selected=project(current.projectId);
      projectButton.replaceChildren(); projectButton.insertAdjacentHTML('beforeend',icon('folder'));
      const name=document.createElement('span'); name.textContent=selected?selected.name:'选择项目'; projectButton.append(name);
      projectButton.title=selected?selected.path:'未选择项目时，文件按对话保存在 Relay 工作区';
      projectButton.disabled=!!current.running;
      const kind=current.executionMode && current.executionMode.kind || 'default';
      // Derive every mode affordance from the active conversation. Navigation,
      // permission refresh and context reset also call sync, not just mode clicks.
      if(input)input.placeholder=kind==='plan'?'描述需要分析和规划的任务…':kind==='goal'?'描述目标及完成条件…':'发消息…';
      modeButton.hidden=kind==='default'; modeButton.disabled=!!current.running;
      modeButton.innerHTML=icon(kind==='plan'?'plan':'goal');
      const label=document.createElement('span');label.textContent=kind==='plan'?'计划模式':'目标';modeButton.append(label);
      modeButton.insertAdjacentHTML('beforeend',icon('close'));modeButton.title='切回普通对话';
    }
    function close(restore=false) {
      menuRevision++;menuBack=null;
      if(menu)menu.remove(); menu=null;
      if(anchor) { anchor.setAttribute('aria-expanded','false'); if(restore)anchor.focus(); } anchor=null;
    }
    function position() {
      if(!menu||!anchor)return;
      const variant=menu.dataset.variant,full=variant==='composer-add';
      const rect=(full?inputCard:anchor).getBoundingClientRect(),gap=full?8:10;
      const width=full?rect.width:Math.min(variant==='project-actions'?220:variant==='project-picker'?280:320,innerWidth-24);
      const availableAbove=Math.max(0,rect.top-gap-42),availableBelow=Math.max(0,innerHeight-rect.bottom-gap-12);
      menu.dataset.compact=String(full&&menu.dataset.page==='projects'&&availableAbove<240);
      const above=full||availableAbove>=Math.min(variant==='project-picker'?288:230,availableBelow);
      menu.style.width=width+'px';
      menu.style.maxHeight=Math.max(0,Math.min(full?440:variant==='project-picker'?288:innerHeight-54,above?availableAbove:availableBelow))+'px';
      if(menu.dataset.variant==='project-actions')measureProjectName(menu.querySelector('.composer-menu-heading'));
      menu.querySelectorAll('.project-picker-list .composer-menu-label>span').forEach(measureProjectName);
      const height=menu.offsetHeight;
      menu.style.left=(full?rect.left:Math.max(12,Math.min(rect.left,innerWidth-width-12)))+'px';
      menu.style.top=(above?Math.max(42,rect.top-height-gap):rect.bottom+gap)+'px';
    }
    function open(button,title,variant='default') {
      options.beforeOpen?.();
      close();anchor=button;anchor.setAttribute('aria-expanded','true');
      menu=document.createElement('div');menu.className='composer-add-menu';menu.dataset.variant=variant;menu.setAttribute('role','menu');menu.setAttribute('aria-label',title);
      const heading=document.createElement('div');heading.className='composer-menu-heading';heading.textContent=title;heading.title=title;menu.append(heading);document.body.append(menu);return menu;
    }
    function row(label, glyph, action, { detail='', checked=false, disabled=false, role='menuitem',host=menu,keepOpen=false,chevron=false,title='' }={}) {
      const button=document.createElement('button');button.type='button';button.className='composer-menu-item';button.disabled=disabled;button.setAttribute('role',role);
      if(role==='menuitemradio')button.setAttribute('aria-checked',String(checked));
      button.innerHTML=icon(glyph);const text=document.createElement('span');text.className='composer-menu-label';
      const name=document.createElement('span');name.textContent=label;text.append(name);
      if(detail){const small=document.createElement('small');small.textContent=detail;text.append(small);}button.append(text);
      if(checked)button.insertAdjacentHTML('beforeend',icon('check'));
      if(chevron)button.insertAdjacentHTML('beforeend',icon('chevron'));
      button.title=title||[label,detail].filter(Boolean).join(' · ');
      button.addEventListener('click',async()=>{if(!keepOpen)close();try{await action();}catch(error){notify(error.message||'操作失败');}});
      host.append(button);return button;
    }
    function focusItem(item) { if(!item)return;item.focus({preventScroll:true});item.scrollIntoView({block:'nearest'}); }
    function finishOpen() { position(); focusItem(menu.querySelector('input,button:not(:disabled)')); }
    function isOpening(ownMenu,token,opening) { const now=context();return menu===ownMenu&&menuRevision===token&&ownMenu.isConnected&&now.conversationId===opening.conversationId&&now.navigationVersion===opening.navigationVersion; }
    function status(host,text) {const node=document.createElement('div');node.className='composer-menu-status';node.setAttribute('role','status');node.textContent=text;host.replaceChildren(node);return node;}
    async function chooseFolderProject() {
      const dir=await api.openFolderDialog();if(!dir)return null;
      const result=await api.projects.add({path:dir.path,name:dir.name});if(!result||!result.ok)throw Error(result&&result.error||'无法创建项目');
      await refresh();await refreshHistory();return result.project;
    }
    async function createAndSelect(startNew=false, targetId=null) {
      const captured=context();const item=await chooseFolderProject();if(!item)return;
      // Native folder dialogs can remain open while navigation changes.
      if((!targetId || captured.isDraft && targetId===captured.conversationId)
        && (context().conversationId!==captured.conversationId || context().navigationVersion!==captured.navigationVersion))return;
      if(startNew)newConversation(item.id);else await selectProject(item.id,targetId);
      sync();
    }
    function populateProjectPicker(host,ownMenu,opening,conversationId=null) {
      const originId=conversationId || opening.conversationId,token=menuRevision;
      const isCurrent=()=>isOpening(ownMenu,token,opening)&&host.isConnected;
      const searchBox=document.createElement('div');searchBox.className='project-picker-search';searchBox.innerHTML=icon('search');host.append(searchBox);
      const search=document.createElement('input');search.type='search';search.placeholder='搜索项目';search.setAttribute('aria-label','搜索项目');search.className='project-search';searchBox.append(search);
      const list=document.createElement('div');list.className='project-picker-list';host.append(list);
      const footer=document.createElement('div');footer.className='project-picker-footer';host.append(footer);
      let current=opening,items=null;
      const choose=async id=>{await selectProject(id,originId);sync();await refreshHistory();};
      const createButton=row('新建项目','plus',()=>createAndSelect(false,originId),{host:footer,disabled:true});
      const noProject=row('不在项目中工作','folder',()=>choose(null),{host:footer,disabled:true,role:'menuitemradio',title:'不在项目中工作 · 文件按对话保存在 Relay 工作区'});
      function render() {
        if(!items)return;
        const q=search.value.trim().toLowerCase();
        const visible=items.filter(item=>[item.name,item.path].some(value=>String(value||'').toLowerCase().includes(q)));
        if(!q)visible.sort((a,b)=>Number(b.id===current.projectId)-Number(a.id===current.projectId));
        list.replaceChildren();
        for(const item of visible) {
          const button=row(item.name,'folder',()=>choose(item.id),{host:list,title:item.path,checked:current.projectId===item.id,role:'menuitemradio',disabled:!!current.running});
          button.dataset.projectId=item.id;
        }
        if(!visible.length)status(list,q?'没有找到项目':'还没有项目');
        list.scrollTop=0;position();
      }
      async function loadProjects() {
        status(list,'正在加载项目…');position();
        try {
          const [target,loaded]=await Promise.all([conversationId?api.history.load(conversationId):Promise.resolve(null),refresh({quiet:true,throwOnError:true})]);
          if(!isCurrent())return;
          if(conversationId&&!target)throw Error('对话不存在，请刷新后重试');
          current=target||context();items=loaded;
          createButton.disabled=!!current.running;noProject.disabled=!!current.running;
          noProject.setAttribute('aria-checked',String(!current.projectId));
          if(!current.projectId)noProject.insertAdjacentHTML('beforeend',icon('check'));
          render();
        } catch(error) {
          if(!isCurrent())return;
          status(list,error.message||'项目加载失败');
          row('重试','back',loadProjects,{host:list,keepOpen:true});position();
        }
      }
      search.addEventListener('input',render);position();focusItem(search);
      void loadProjects();
    }
    function projectPicker(button=projectButton, conversationId=null) {
      const opening=context();
      if(!button.isConnected || !button.getClientRects().length)return;
      const ownMenu=open(button,conversationId?'移动到项目':'在项目中工作','project-picker');
      populateProjectPicker(ownMenu,ownMenu,opening,conversationId);
    }
    function addMenu() {
      if(menu&&anchor===attach){close();return;}
      const opening=context(),kind=opening.executionMode&&opening.executionMode.kind||'default';
      const ownMenu=open(attach,'添加','composer-add'),token=menuRevision;ownMenu.dataset.page='home';
      const home=document.createElement('div');home.className='composer-add-home';ownMenu.append(home);
      const chooseAttachments=async kind=>{
        const owner=options.captureAttachmentOwner?.();
        const files=await api.openAttachmentDialog({kind,defaultPath:project(opening.projectId)?.path});
        const now=context();
        if(files&&(owner||now.conversationId===opening.conversationId&&now.navigationVersion===opening.navigationVersion))addFiles(files,owner);
      };
      const filesButton=row('添加文件','file',()=>chooseAttachments('files'),{host:home,detail:'选择任务需要的参考文件'});
      filesButton.dataset.attachmentKind='files';
      const projectsButton=row('在项目中工作','folder',()=>{
        ownMenu.style.height=ownMenu.getBoundingClientRect().height+'px';
        home.hidden=true;ownMenu.dataset.page='projects';ownMenu.setAttribute('aria-label','在项目中工作');
        const heading=ownMenu.querySelector(':scope>.composer-menu-heading');heading.textContent=heading.title='在项目中工作';
        const page=document.createElement('div');page.className='composer-projects-page';ownMenu.append(page);
        const back=row('返回','back',()=>menuBack?.(),{host:page,keepOpen:true});back.classList.add('composer-menu-back');
        menuBack=()=>{
          page.remove();home.hidden=false;ownMenu.dataset.page='home';ownMenu.style.height='';
          heading.textContent=heading.title='添加';ownMenu.setAttribute('aria-label','添加');menuBack=null;position();focusItem(projectsButton);
        };
        populateProjectPicker(page,ownMenu,opening);
      },{host:home,detail:'选择任务使用的项目',disabled:opening.running,chevron:true,keepOpen:true});
      row('目标','goal',()=>setMode({kind:kind==='goal'?'default':'goal'}),{host:home,detail:'持续推进，直到完成目标',checked:kind==='goal',disabled:opening.running,role:'menuitemradio'});
      row('计划模式','plan',()=>setMode({kind:kind==='plan'?'default':'plan'}),{host:home,detail:'先分析与规划，再决定执行',checked:kind==='plan',disabled:opening.running,role:'menuitemradio'});
      const section=document.createElement('section');section.className='composer-skills-section';home.append(section);
      const header=document.createElement('div');header.className='composer-skills-heading';section.append(header);
      const heading=document.createElement('span');heading.textContent='技能';header.append(heading);
      const search=document.createElement('input');search.type='search';search.placeholder='搜索技能';search.setAttribute('aria-label','搜索技能');search.className='composer-skill-search';header.append(search);
      const selected=opening.selectedSkill;
      if(selected) {const clear=document.createElement('button');clear.type='button';clear.className='composer-skill-clear';clear.textContent='清除';clear.title='取消当前技能';clear.setAttribute('role','menuitem');clear.addEventListener('click',()=>{close();options.selectSkill?.(null);});header.append(clear);}
      const list=document.createElement('div');list.className='composer-skill-list';section.append(list);
      let skills=null,request=0;
      function renderSkills() {
        if(!skills)return;
        const q=search.value.trim().toLowerCase();
        const filtered=skills.filter(skill=>[skill.name,skill.displayName,skill.callName,skill.desc,skill.description,skill.summary].some(value=>String(value||'').toLowerCase().includes(q)));
        list.replaceChildren();
        for(const skill of filtered) {
          const label=skill.displayName||skill.name,description=skill.summary||skill.desc||skill.description||'使用此技能处理任务';
          const checked=!!selected&&selected.name===skill.name;
          const item=row(label,'skill',()=>options.selectSkill?.(checked?null:skill),{host:list,detail:description,checked,role:'menuitemradio'});
          item.classList.add('composer-skill-item');item.dataset.skillName=skill.name;
        }
        if(!filtered.length)status(list,q?'没有找到技能':'还没有可用技能，可在插件中添加');
        list.scrollTop=0;position();
      }
      async function loadSkills() {
        const ownRequest=++request;status(list,'正在加载技能…');position();
        try {
          const response=await (options.listSkills?options.listSkills():api.data.listSkills());
          if(!isOpening(ownMenu,token,opening)||ownRequest!==request)return;
          if(response&&response.ok===false)throw Error(response.error||'技能加载失败');
          skills=(Array.isArray(response)?response:response?.items||[]).filter(skill=>skill&&skill.name);
          renderSkills();
        } catch(error) {
          if(!isOpening(ownMenu,token,opening)||ownRequest!==request)return;
          status(list,error.message||'技能加载失败');row('重试','back',loadSkills,{host:list,keepOpen:true});position();
        }
      }
      search.addEventListener('input',renderSkills);
      finishOpen();
      void loadSkills();
    }
    async function projectMenu(button,item) {
      open(button,item.name,'project-actions');
      row('新建对话','plus',()=>newConversation(item.id));
      row('打开文件夹','folder',async()=>{const result=await api.projects.open(item.id);if(!result.ok)throw Error(result.error);});
      row('重命名','edit',async()=>{const name=await prompt({title:'重命名项目',value:item.name,maxLength:80});if(name==null)return;const r=await api.projects.rename({id:item.id,name});if(!r.ok)throw Error(r.error);await refresh();await refreshHistory();});
      row('移除项目','close',async()=>{if(!await confirm({title:'移除项目',message:'文件和对话会保留，对话将回到 Relay 工作区。',confirmText:'移除'}))return;const r=await api.projects.remove(item.id);if(!r.ok)throw Error(r.error);await refresh();if(context().projectId===item.id)await selectProject(null);await refreshHistory();});
      finishOpen();
    }
    function header(section,item) {
      section.classList.add('history-project');section.dataset.projectId=item.id;
      let heading=section.querySelector('.history-group-heading');
      if(!heading.dataset.projectHeader){
        heading.textContent='';heading.dataset.projectHeader='true';
        const toggle=document.createElement('button');toggle.type='button';toggle.className='project-chevron';toggle.innerHTML=icon('chevron');heading.append(toggle);
        const title=document.createElement('button');title.type='button';title.className='project-name';title.innerHTML=icon('folder')+'<span></span>';heading.append(title);
        const add=document.createElement('button');add.type='button';add.className='project-new-chat';add.innerHTML=icon('plus');add.title='在项目中新建对话';add.setAttribute('aria-label','在项目中新建对话');heading.append(add);
        const more=document.createElement('button');more.type='button';more.className='project-more';more.innerHTML=icon('more');more.title='项目操作';more.setAttribute('aria-label','项目操作');heading.append(more);
        toggle.addEventListener('click',()=>{if(collapsed.has(item.id))collapsed.delete(item.id);else collapsed.add(item.id);try{localStorage.setItem('relay.projects.collapsed',JSON.stringify([...collapsed]));}catch(_){}header(section,project(item.id)||item);});
        title.addEventListener('click',()=>newConversation(item.id));add.addEventListener('click',()=>newConversation(item.id));
        more.addEventListener('click',()=>projectMenu(more,project(item.id)||item));heading.addEventListener('contextmenu',event=>{event.preventDefault();projectMenu(more,project(item.id)||item);});
      }
      const name=heading.querySelector('.project-name span');name.textContent=item.name;name.title=item.name;
      heading.querySelector('.project-name').title=item.path;
      const opened=!collapsed.has(item.id);section.classList.toggle('is-collapsed',!opened);section.classList.toggle('is-selected',context().projectId===item.id);
      const folder=heading.querySelector('.project-name > svg'), folderState=opened?'open':'closed';
      if(folder.dataset.folderState!==folderState){folder.innerHTML=paths[opened?'folderOpen':'folder'];folder.dataset.folderState=folderState;}
      const toggle=heading.querySelector('.project-chevron');toggle.setAttribute('aria-expanded',String(opened));toggle.setAttribute('aria-label',(opened?'收起':'展开')+'项目 '+item.name);
      section.querySelector('.history-group-items').hidden=!opened;
      measureProjectName(name);
    }
    attach.addEventListener('click',event=>{event.stopPropagation();addMenu();});
    projectButton.addEventListener('click',()=>projectPicker());modeButton.addEventListener('click',()=>setMode({kind:'default'}));
    document.getElementById('btnAddProject').addEventListener('click',()=>void createAndSelect(true).catch(error=>notify(error.message)));
    document.addEventListener('pointerdown',event=>{if(menu&&!menu.contains(event.target)&&!(anchor&&anchor.contains(event.target)))close();});
    document.addEventListener('keydown',event=>{
      if(!menu)return;
      if(event.isComposing)return;
      if(event.key==='Escape'){event.preventDefault();close(true);return;}
      const editing=event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target.isContentEditable;
      if(menuBack&&!editing&&['ArrowLeft','Backspace'].includes(event.key)){event.preventDefault();menuBack();return;}
      if(!['ArrowDown','ArrowUp','Home','End','Tab'].includes(event.key))return;
      if(event.key==='Tab'){close();return;}
      if(editing&&['Home','End'].includes(event.key))return;
      const buttons=[...menu.querySelectorAll('input,button:not(:disabled)')].filter(el=>!el.closest('[hidden]')&&el.getClientRects().length);if(!buttons.length)return;
      event.preventDefault();const index=buttons.indexOf(document.activeElement),step=event.key==='ArrowUp'?-1:1;
      focusItem(buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+step+buttons.length)%buttons.length]);
    });
    window.addEventListener('resize',()=>{position();measureProjectNames();});
    window.addEventListener('relay:sidebar-changed',position);
    window.addEventListener('relay:workspace-layout',position);
    return {refresh,sync,header,projectPicker,close,projects:()=>projects,project};
  }
  root.RelayProjectsComposer={create};
})(window);
