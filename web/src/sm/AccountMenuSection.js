// stremio-music: "this server" account entries for the upstream profile menu (Movies & TV).
// Upstream's own Log in / Log out there is the Stremio.com account, which is separate.

const React = require('react');
const PropTypes = require('prop-types');
const { default: Icon } = require('@stremio/stremio-icons/react');
const { Button } = require('stremio/components');
const { getAuthState, signOut, accountUrl } = require('./api');

const AccountMenuSection = ({ styles }) => {
    const [state, setState] = React.useState(null);

    React.useEffect(() => {
        getAuthState().then(setState).catch(() => {});
    }, []);

    return (
        <div className={styles['nav-menu-section']}>
            <Button className={styles['nav-menu-option-container']} title={'Stremio Music account'} href={accountUrl()}>
                <Icon className={styles['icon']} name={'person-outline'} />
                <div className={styles['nav-menu-option-label']}>
                    {state?.user ? `Account · ${state.user.username}` : 'Account'}
                </div>
            </Button>
            {
                state?.mode === 'local' ?
                    <Button className={styles['nav-menu-option-container']} title={'Sign out of Stremio Music'} onClick={signOut}>
                        <Icon className={styles['icon']} name={'exit'} />
                        <div className={styles['nav-menu-option-label']}>{'Sign out of Stremio Music'}</div>
                    </Button>
                    :
                    null
            }
        </div>
    );
};

AccountMenuSection.propTypes = {
    styles: PropTypes.object.isRequired,
};

module.exports = AccountMenuSection;
