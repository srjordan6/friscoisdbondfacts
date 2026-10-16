(function(){
  var btn=document.querySelector('.menu-btn'),nav=document.getElementById('site-nav');
  if(!btn||!nav) return;
  var closeBtn=nav.querySelector('.nav-close');
  function shut(){nav.classList.remove('open');document.body.classList.remove('menu-open');btn.setAttribute('aria-expanded','false')}
  function setOpen(open){if(!open){shut();btn.focus();return}
    nav.classList.add('open');document.body.classList.add('menu-open');btn.setAttribute('aria-expanded','true');var a=nav.querySelector('a');if(a)a.focus()}
  btn.addEventListener('click',function(){setOpen(true)});
  closeBtn.addEventListener('click',function(){setOpen(false)});
  nav.addEventListener('click',function(e){if(e.target.closest('a')&&nav.classList.contains('open'))shut()});
  document.addEventListener('keydown',function(e){
    if(!nav.classList.contains('open')) return;
    if(e.key==='Escape'){setOpen(false);return}
    if(e.key==='Tab'){var f=nav.querySelectorAll('a,button'),first=f[0],last=f[f.length-1];
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
      else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}
  });
  window.matchMedia('(min-width:721px)').addEventListener('change',function(m){if(m.matches)shut()});
})();
