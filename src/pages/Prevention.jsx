import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import Icon from '../components/Icon';
import { getDiseaseGuide } from '../services/diseaseGuide';

function GuideText({ children }) {
  const parts = children.split(/(\*\*.+?\*\*)/g);
  return parts.map((part, index) => part.startsWith('**')
    ? <strong key={index}>{part.slice(2, -2)}</strong>
    : part);
}

function Prevention() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const guide = useMemo(() => getDiseaseGuide(i18n.language), [i18n.language]);
  const [openSection, setOpenSection] = useState(null);
  const [showAll, setShowAll] = useState(false);

  const diseaseSections = guide.sections.slice(0, 4);
  const generalSection = guide.sections[4];
  const visibleSections = showAll ? diseaseSections : diseaseSections.slice(0, 4);

  function toggleSection(title) {
    setOpenSection((current) => current === title ? null : title);
  }

  return (
    <div className="page page-enter prevention-page">
      <div className="prevention-hero">
        <div className="prevention-kicker"><Icon name="leaf" size={17} /> {t('prevention_kicker')}</div>
        <h1>{t('prevention_title')}</h1>
        <p>{guide.intro || t('prevention_subtitle')}</p>
      </div>

      <div className="prevention-alert">
        <Icon name="alert" size={24} />
        <div>
          <strong>{t('prevention_safety_title')}</strong>
          <p>{guide.warning}</p>
        </div>
      </div>

      <section className="prevention-now" aria-labelledby="prevention-now-title">
        <div className="section-heading-row">
          <div>
            <span className="eyebrow">{t('prevention_now_eyebrow')}</span>
            <h2 id="prevention-now-title">{t('prevention_now_title')}</h2>
          </div>
          <span className="step-count">{Math.min(3, generalSection?.actions.length || 0)} {t('prevention_steps')}</span>
        </div>
        <div className="now-list">
          {(generalSection?.actions || []).slice(0, 3).map((action, index) => (
            <div className="now-step" key={action}>
              <span className="step-number">{index + 1}</span>
              <p><GuideText>{action}</GuideText></p>
            </div>
          ))}
        </div>
        <button className="text-button" type="button" onClick={() => generalSection && toggleSection(generalSection.title)}>
          <Icon name="search" size={17} /> {t('prevention_open_basics')}
        </button>
      </section>

      <div className="prevention-list-header">
        <div>
          <span className="eyebrow">{t('prevention_library_eyebrow')}</span>
          <h2>{t('prevention_library_title')}</h2>
        </div>
        <button className="compact-toggle" type="button" onClick={() => setShowAll((current) => !current)}>
          {showAll ? t('prevention_show_less') : t('prevention_show_all')}
        </button>
      </div>

      <div className="guide-accordion" aria-label={t('prevention_library_title')}>
        {visibleSections.map((section, index) => {
          const isOpen = openSection === section.title;
          return (
            <article className={`guide-item ${isOpen ? 'is-open' : ''}`} key={section.title}>
              <button
                className="guide-trigger"
                type="button"
                aria-expanded={isOpen}
                onClick={() => toggleSection(section.title)}
              >
                <span className="guide-index">0{index + 1}</span>
                <span className="guide-trigger-copy">
                  <strong>{section.title}</strong>
                  <small>{section.paragraphs[0]?.slice(0, 74)}...</small>
                </span>
                <Icon name="plus" size={20} className={isOpen ? 'rotate-45' : ''} />
              </button>
              {isOpen && (
                <div className="guide-content">
                  {section.paragraphs.map((paragraph) => <p key={paragraph}><GuideText>{paragraph}</GuideText></p>)}
                  {section.actions.length > 0 && (
                    <div className="action-list">
                      {section.actions.map((action) => (
                        <div className="guide-action" key={action}><Icon name="check" size={17} /><p><GuideText>{action}</GuideText></p></div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}

        {generalSection && (
          <article className={`guide-item guide-item-general ${openSection === generalSection.title ? 'is-open' : ''}`}>
            <button className="guide-trigger" type="button" aria-expanded={openSection === generalSection.title} onClick={() => toggleSection(generalSection.title)}>
              <span className="guide-index"><Icon name="leaf" size={17} /></span>
              <span className="guide-trigger-copy"><strong>{generalSection.title}</strong><small>{t('prevention_general_hint')}</small></span>
              <Icon name="plus" size={20} className={openSection === generalSection.title ? 'rotate-45' : ''} />
            </button>
            {openSection === generalSection.title && (
              <div className="guide-content">
                {generalSection.paragraphs.map((paragraph) => <p key={paragraph}><GuideText>{paragraph}</GuideText></p>)}
                {generalSection.actions.map((action) => <div className="guide-action" key={action}><Icon name="check" size={17} /><p><GuideText>{action}</GuideText></p></div>)}
              </div>
            )}
          </article>
        )}
      </div>

      <div className="prevention-footer">
        <p>{t('prevention_footer')}</p>
        <button className="btn btn-primary" type="button" onClick={() => navigate('/camera')}><Icon name="scan" size={18} /> {t('prevention_scan_cta')}</button>
      </div>
    </div>
  );
}

export default Prevention;
