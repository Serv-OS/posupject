import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import Today from './Today.jsx';
import TaskDetail from './TaskDetail.jsx';
import ProjectDetail from './ProjectDetail.jsx';
import MobileNav from './MobileNav.jsx';
import QuickAddCommand from './QuickAddCommand.jsx';
const P={id:'u-peter',display_name:'Peter',email:'peter@posup.co.uk',role:'owner'};
function App(){
  const [v,setV]=useState(()=> (location.hash||'#today').slice(1));
  useEffect(()=>{const f=()=>setV(location.hash.slice(1)||'today');window.addEventListener('hashchange',f);return()=>window.removeEventListener('hashchange',f);},[]);
  return (
    <div style={{height:'100vh',display:'flex',flexDirection:'column',background:'var(--scene-bg)'}}>
      <main className="work" style={{flex:1,minWidth:0,overflowY:'auto'}}>
        {v==='today'&&<Today profile={P} onNavigate={()=>{}}/>}
        {v==='task'&&<TaskDetail taskId="t3" profile={P} onClose={()=>{}} onNavigate={()=>{}}/>}
        {v==='project'&&<ProjectDetail projectId="p1" profile={P} onClose={()=>{}} onSelectTask={()=>{}} onNavigate={()=>{}}/>}
      </main>
      <MobileNav profile={P} view={v==='project'?'projects':v} onGo={(k)=>{location.hash=k;}}/>
      <QuickAddCommand profile={P} onNavigate={()=>{}}/>
    </div>
  );
}
createRoot(document.getElementById('root')).render(<App/>);
