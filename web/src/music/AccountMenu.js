// stremio-music: account menu in the Music top bar.

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const { signOut, accountUrl } = require('stremio/sm/api');
const styles = require('./styles');

const AccountMenu = ({ user }) => {
    const [open, setOpen] = React.useState(false);
    const rootRef = React.useRef(null);

    React.useEffect(() => {
        if (!open) return;
        const onPointerDown = (event) => {
            if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        };
        const onKeyDown = (event) => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);

    return (
        <div ref={rootRef} className={styles['account']}>
            <button
                type={'button'}
                className={classnames(styles['icon-button'], { [styles['active']]: open })}
                aria-haspopup={'menu'}
                aria-expanded={open}
                title={user ? user.username : 'Account'}
                onClick={() => setOpen((value) => !value)}
            >
                <Icon className={styles['icon']} name={'person-outline'} />
            </button>
            {
                open ?
                    <div className={styles['account-menu']} role={'menu'}>
                        {user ? <div className={styles['account-user']}>{user.username}</div> : null}
                        <a className={styles['menu-item']} role={'menuitem'} href={accountUrl()}>
                            <Icon className={styles['menu-icon']} name={'person-outline'} />
                            {'Account'}
                        </a>
                        <a className={styles['menu-item']} role={'menuitem'} href={'#/settings'} onClick={() => setOpen(false)}>
                            <Icon className={styles['menu-icon']} name={'settings'} />
                            {'Movies & TV settings'}
                        </a>
                        <button type={'button'} className={styles['menu-item']} role={'menuitem'} onClick={signOut}>
                            <Icon className={styles['menu-icon']} name={'exit'} />
                            {'Sign out'}
                        </button>
                    </div>
                    :
                    null
            }
        </div>
    );
};

AccountMenu.propTypes = {
    user: PropTypes.shape({ username: PropTypes.string }),
};

module.exports = AccountMenu;
