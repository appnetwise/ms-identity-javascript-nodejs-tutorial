/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

const msal = require('@azure/msal-node');
const jwt = require('jsonwebtoken')
const jwksClient = require('jwks-rsa');
const axios = require('axios');

const constants = require('./constants');
const CryptoUtilities = require('./CryptoUtilities');

/**
 * MsalNodeWrapper is a simple wrapper around MSAL Node
 * ConfidentialClientApplication object. It offers a collection of middleware 
 * and utility methods that automate basic authentication and authorization
 * tasks in Express MVC web apps and APIs. 
 * 
 * You must have express and express-sessions packages installed. Middleware here 
 * can be used with express sessions in route controllers.
 * 
 * Session variables accessible are as follows:
    * req.session.isAuthenticated => boolean
    * req.session.isAuthorized => boolean
    * req.session.idTokenClaims => object
    * req.session.account => object
    * req.session.resourceName.accessToken => string
    * req.session.resourceName.resourceResponse => object
    * req.session.homeAccountId => string
    * reg.session.nonce => string
    * req.session.authCodeRequest => object
    * req.session.tokenRequest => object
 */
class MsalNodeWrapper {

    // configuration object passed in constructor
    rawConfig;

    // MSAL Node configuration object
    msalConfig;

    // MSAL Node ConfidentialClientApplication object
    msalClient;
    
    /**
     * 
     * @param {JSON} config: auth.json 
     * @param {Object} cache: cachePlugin
     */
    constructor(config, cache = null) {
        MsalNodeWrapper.validateConfiguration(config);

        this.rawConfig = config;
        this.msalConfig = MsalNodeWrapper.shapeConfiguration(config, cache);
        this.msalClient = new msal.ConfidentialClientApplication(this.msalConfig);
    };

    /**
     * Validates the fields in the custom JSON configuration file
     * @param {JSON} config: auth.json
     */
    static validateConfiguration = (config) => {

        // TODO: expand validation logic

        if (!config.credentials.clientId) {
            throw new Error("error: no clientId provided");
        }

        if (!config.credentials.tenantId) {
            throw new Error("error: no tenantId provided"); 
        }

        if (!config.credentials.clientSecret) {
            throw new Error("error: no clientSecret provided"); 
        }
    };

    /**
     * Maps the custom JSON configuration file to configuration
     * object expected by MSAL Node ConfidentialClientApplication
     * @param {JSON} config
     * @param {Object} cachePlugin: passed at initialization
     */
    static shapeConfiguration = (config, cachePlugin) => {
        return {
            auth: {
                clientId: config.credentials.clientId,
                authority: config.hasOwnProperty('policies') ? config.policies.signUpSignIn.authority : constants.AuthorityStrings.AAD + config.credentials.tenantId, // single organization
                clientSecret: config.credentials.clientSecret,
                redirectUri: config.hasOwnProperty('configuration') ? config.configuration.redirectUri : "", // defaults to calling page
                knownAuthorities: config.hasOwnProperty('policies') ? [config.policies.authorityDomain] : [], // in B2C scenarios
            },
            cache: {
                cachePlugin,
            },
            system: {
                loggerOptions: {
                    loggerCallback(loglevel, message, containsPii) {
                        console.log(message);
                    },
                    piiLoggingEnabled: false, 
                    logLevel: msal.LogLevel.Verbose,
                }
            }
        };
    };

    // ========= MIDDLEWARE ===========

    /**
     * Initiate sign in flow
     * @param {Object} req: express request object
     * @param {Object} res: express response object
     * @param {Function} next: express next 
     */
    signIn = (req, res, next) => {

        /** 
         * Request Configuration
         * We manipulate these three request objects below 
         * to acquire a token with the appropriate claims
         */        

        if (!req.session['authCodeRequest']) {
            req.session.authCodeRequest = {
                authority: "",
                scopes: [],
                state: {},
                redirectUri: ""
            };
        }

        if (!req.session['tokenRequest']) {
            req.session.tokenRequest = {
                authority: "",
                scopes: [],
                state: {},
                redirectUri: ""
            };
        }

        // current account id
        req.session.homeAccountId = "";

        // random GUID for csrf check 
        req.session.nonce = CryptoUtilities.generateGuid();

        // state in context
        const state = Object.keys(req.session.authCodeRequest.state).length !== 0 ? 
            JSON.parse(CryptoUtilities.base64DecodeUrl(req.session.authCodeRequest.state)) : null;
            
        /**
         * We check here what this sign-in is for. In B2C scenarios, a sign-in 
         * can be for initiating the password reset user-flow. 
         */
        if (state && state.stage === constants.AppStages.RESET_PASSWORD) {
            let state = CryptoUtilities.base64EncodeUrl(
                JSON.stringify({
                    stage: constants.AppStages.RESET_PASSWORD,
                    path: req.route.path,
                    nonce: req.session.nonce
                }));
    
            // if coming for password reset, set the authority to resetPassword
            this.getAuthCode(
                this.rawConfig.policies.resetPassword.authority, 
                Object.values(constants.OIDCScopes), 
                state, 
                this.msalConfig.auth.redirectUri,
                req,
                res
                );

        } else {
            // sign-in as usual
            let state = CryptoUtilities.base64EncodeUrl(
                JSON.stringify({
                    stage: constants.AppStages.SIGN_IN,
                    path: req.route.path,
                    nonce: req.session.nonce
                }));

            // get url to sign user in (and consent to scopes needed for application)
            this.getAuthCode(
                this.msalConfig.auth.authority, 
                Object.values(constants.OIDCScopes), 
                state, 
                this.msalConfig.auth.redirectUri,
                req, 
                res
            );
        }
    };

    /**
     * Initiate sign out and clean the session
     * @param {Object} req: express request object
     * @param {Object} res: express response object
     * @param {Function} next: express next 
     */
    signOut = (req, res) => {

        /**
         * Construct a logout URI and redirect the user to end the 
         * session with Azure AD/B2C. For more information, visit: 
         * (AAD) https://docs.microsoft.com/azure/active-directory/develop/v2-protocols-oidc#send-a-sign-out-request
         * (B2C) https://docs.microsoft.com/azure/active-directory-b2c/openid-connect#send-a-sign-out-request
         */
        const logoutURI = `${this.msalConfig.auth.authority}/oauth2/v2.0/logout?post_logout_redirect_uri=${this.rawConfig.configuration.postLogoutRedirectUri}`;

        req.session.isAuthenticated = false;
        
        req.session.destroy(() => {
            res.redirect(logoutURI);
        });
    };
    
    /**
     * Middleware that handles redirect depending on request state
     * There are basically 3 states: sign-in, acquire token
     * and password reset user-flows for B2C scenarios
     * @param {Object} req: express request object
     * @param {Object} res: express response object
     * @param {Function} next: express next 
     */
    handleRedirect = async(req, res, next) => {

        const state = JSON.parse(CryptoUtilities.base64DecodeUrl(req.query.state));

        // check if nonce matches
        if (state.nonce === req.session.nonce) {
            if (state.stage === constants.AppStages.SIGN_IN) {

                // token request should have auth code
                const tokenRequest = {
                    redirectUri: this.msalConfig.auth.redirectUri,
                    scopes: Object.keys(constants.OIDCScopes),
                    code: req.query.code,
                };

                try {
                    // exchange auth code for tokens
                    const tokenResponse = await this.msalClient.acquireTokenByCode(tokenRequest)
                    console.log("\nResponse: \n:", tokenResponse);

                    if (this.validateIdToken(tokenResponse.idTokenClaims)) {
                                
                        req.session.homeAccountId = tokenResponse.account.homeAccountId;

                        // assign session variables
                        req.session.idTokenClaims = tokenResponse.idTokenClaims;
                        req.session.isAuthenticated = true;

                        return res.status(200).redirect(this.rawConfig.configuration.homePageRoute);
                    } else {
                        console.log('invalid token');
                        return res.status(401).send("Not Permitted");
                    }  
                } catch (error) {
                    console.log(error);

                    if (req.query.error) {

                        /**
                         * When the user selects "forgot my password" on the sign-in page, B2C service will throw an error.
                         * We are to catch this error and redirect the user to login again with the resetPassword authority.
                         * For more information, visit: https://docs.microsoft.com/azure/active-directory-b2c/user-flow-overview#linking-user-flows
                         */
                        if (JSON.stringify(req.query.error_description).includes("AADB2C90118")) {

                            req.session.nonce = CryptoUtilities.generateGuid();

                            let newState = CryptoUtilities.base64EncodeUrl(
                                JSON.stringify({
                                    stage: constants.AppStages.RESET_PASSWORD,
                                    path: req.route.path,
                                    nonce: req.session.nonce
                                }));

                            req.session.authCodeRequest.state = newState;
                            req.session.authCodeRequest.authority = this.rawConfig.policies.resetPassword.authority;

                            // redirect to sign in page again with resetPassword authority
                            return res.redirect(state.path);
                        } 
                    }

                    res.status(500).send(error);
                }

            } else if (state.stage === constants.AppStages.ACQUIRE_TOKEN) {

                // get the name of the resource associated with scope
                let resourceName = this.getResourceName(state.path);

                const tokenRequest = {
                    code: req.query.code,
                    scopes: this.rawConfig.resources[resourceName].scopes, // scopes for resourceName
                    redirectUri: this.rawConfig.configuration.redirectUri,
                };

                try {
                    const tokenResponse = await this.msalClient.acquireTokenByCode(tokenRequest);
                    console.log("\nResponse: \n:", tokenResponse);

                    req.session[resourceName].accessToken = tokenResponse.accessToken;

                    try {
                        const resourceResponse = await this.callAPI(this.rawConfig.resources[resourceName].endpoint, tokenResponse.accessToken);
                        req.session[resourceName].resourceResponse = resourceResponse;
                        return res.status(200).redirect(state.path);
                    } catch (error) {
                        console.log(error);
                        res.status(500).send(error);
                    }

                } catch (error) {
                    console.log(error);
                    res.status(500).send(error);
                }
            } else if (state.stage === constants.AppStages.RESET_PASSWORD) {
                // once the password is reset, redirect the user to login again with the new password
                req.session.nonce = CryptoUtilities.generateGuid();
                
                let newState = CryptoUtilities.base64EncodeUrl(
                    JSON.stringify({
                        stage: constants.AppStages.SIGN_IN,
                        path: req.route.path,
                        nonce: req.session.nonce
                    }));

                req.session.authCodeRequest.state = newState;

                res.redirect(state.path);
            } else {
                res.status(500).send('Unknown app stage');
            }
        } else {
            console.log('Nonce does not match')
            res.status(401).send('Not Permitted');
        }
    };

    /**
     * Middleware that gets tokens and calls web APIs
     * @param {Object} req: express request object
     * @param {Object} res: express response object
     * @param {Function} next: express next 
     */
    getToken = async(req, res, next) => {

        // get scopes for token request
        let scopes = Object.values(this.rawConfig.resources)
            .find(resource => resource.callingPageRoute === req.route.path).scopes;

        let resourceName = this.getResourceName(req.route.path);
        
        if (!req.session[resourceName]) {
            req.session[resourceName] = {
                accessToken: null,
                resourceResponse: null,
            };
        }

        try {

            let account;

            try {
                account = await this.msalClient.getTokenCache().getAccountByHomeId(req.session.homeAccountId);
                            
                if (!account) {
                    throw new Error("interaction_required");
                }

            } catch (error) {
                console.log(error);
                throw new msal.InteractionRequiredAuthError("interaction_required");
            }

            const silentRequest = {
                account: account,
                scopes: scopes,
            };

            // acquire token silently to be used in resource call
            const tokenResponse = await this.msalClient.acquireTokenSilent(silentRequest)
            console.log("\nSuccessful silent token acquisition:\n Response: \n:", tokenResponse);

            // TODO: In B2C scenarios, sometimes an access token is returned empty
            // due to improper refresh tokens in cache. In that case, we will acquire token
            // interactively instead.
            if (tokenResponse.accessToken.length === 0) {
                console.log('No access token found, falling back to interactive token acquisition');
                throw new msal.InteractionRequiredAuthError("interaction_required");
            }
            
            req.session[resourceName].accessToken = tokenResponse.accessToken;

            try {
                // call the web API
                const resourceResponse = await this.callAPI(this.rawConfig.resources[resourceName].endpoint, tokenResponse.accessToken)
                req.session[resourceName].resourceResponse = resourceResponse;

                return next();

            } catch (error) {
                console.log(error);
            }

        } catch (error) {
            // in case there are no cached tokens, initiate an interactive call
            if (error instanceof msal.InteractionRequiredAuthError) {
                let state = CryptoUtilities.base64EncodeUrl(
                JSON.stringify({
                    stage: constants.AppStages.ACQUIRE_TOKEN,
                    path: req.route.path,
                    nonce: req.session.nonce
                }));

                // initiate the first leg of auth code grant to get token
                this.getAuthCode(
                    this.msalConfig.auth.authority, 
                    scopes, 
                    state, 
                    this.msalConfig.auth.redirectUri,
                    req, 
                    res
                    );
            }
        }  
    };

    /**
     * Middleware that gets token to be used by the 
     * downstream web API on-behalf of user in context
     * @param {Object} req: express request object
     * @param {Object} res: express response object
     * @param {Function} next: express next 
     */
    getTokenOnBehalf = async(req, res, next) => {
        const authHeader = req.headers.authorization;

        let scopes = Object.values(this.rawConfig.resources)
            .find(resource => resource.callingPageRoute === req.route.path).scopes;

        const oboRequest = {
            oboAssertion: authHeader.split(' ')[1],
            scopes: scopes,
        }


        // get the resource name for attaching resource response to req
        const resourceName = this.getResourceName(req.route.path);
        
        try {
            const tokenResponse = await this.msalClient.acquireTokenOnBehalfOf(oboRequest);

            if (tokenResponse) {
                try {
                    const resourceResponse = await this.callAPI(this.rawConfig.resources[resourceName].endpoint, tokenResponse.accessToken);
                    req[resourceName].resourceResponse = resourceResponse;
                    return next();        
                } catch (error) {
                    console.log(error)
                    res.send('Error: Cannot acquire token OBO')
                }
            } else {
                res.status(500).send('No response OBO');
            }
            
        } catch (error) {
            res.status(500).send(error);
        }
    }

    /**
     * Check if authenticated in session
     * @param {Object} req: express request object
     * @param {Object} res: express response object
     * @param {Function} next: express next 
     */
    isAuthenticated = (req, res, next) => {  
        if (req.session) {
            if (!req.session.isAuthenticated) {
                return res.status(401).send("Not Permitted");
            }
            next();
        } else {
            return res.status(401).send("Not Permitted");
        }   
    };

    /**
     * Receives access token in req authorization header
     * and validates it using the jwt.verify
     * @param {Object} req: express request object
     * @param {Object} res: express response object
     * @param {Function} next: express next 
     */
    isAuthorized = async(req, res, next) => {

        if (req.headers.authorization) {
            if (!(await this.validateAccessToken(req))) {
                return res.status(401).send("Not Permitted");
            } 
            next();
        } else {
            res.status(401).send("Not Permitted");
        }
    };

    /**
     * Initiates the edit profile user-flow in
     * B2C scenarios. The user should already be signed-in.
     * @param {Object} req: express request object
     * @param {Object} res: express response object
     * @param {Function} next: express next 
     */
    editProfile = (req, res, next) => {
        
        req.session.nonce = CryptoUtilities.generateGuid();

        let state = CryptoUtilities.base64EncodeUrl(
            JSON.stringify({
                stage: constants.AppStages.SIGN_IN,
                path: req.route.path,
                nonce: req.session.nonce
            }));

        this.getAuthCode(
            this.rawConfig.policies.editProfile.authority, 
            Object.values(constants.OIDCScopes), 
            state, 
            this.msalConfig.auth.redirectUri, 
            req, 
            res
        );
    }

    // ============== UTILS ===============
    
    /**
     * Validates the id token for a set of claims
     * @param {Object} idTokenClaims: decoded id token claims
     */
    validateIdToken = (idTokenClaims) => {
        const now = Math.round((new Date()).getTime() / 1000); // in UNIX format
        
        /**
         * At the very least, check for tenant, audience, issue and expiry dates. 
         * For more information on validating id tokens, visit: 
         * https://docs.microsoft.com/azure/active-directory/develop/id-tokens#validating-an-id_token
         */
        const checkAudience = idTokenClaims["aud"] === this.msalConfig.auth.clientId ? true : false;
        const checkTimestamp = idTokenClaims["iat"] <= now && idTokenClaims["exp"] >= now ? true : false;
        const checkTenant = (this.rawConfig.hasOwnProperty('policies') && !idTokenClaims["tid"]) || idTokenClaims["tid"] === this.rawConfig.credentials.tenantId ? true : false;

        return checkAudience && checkTimestamp && checkTenant;
    };

    /**
     * Validates the access token for signature 
     * and against a predefined set of claims
     * @param {Object} req: Express req object with authorization header
     */
    validateAccessToken = async(req) => {
        const now = Math.round((new Date()).getTime() / 1000); // in UNIX format

        const authHeader = req.headers.authorization;
        const accessToken = authHeader.split(' ')[1];
        
        if (!accessToken || accessToken === "" || accessToken === "undefined") {
            console.log('No tokens found');
            return false;
        }

        // we will first decode to get kid in header
        const decodedToken = jwt.decode(accessToken, {complete: true});
        
        if (!decodedToken) {
            throw new Error('Token cannot be decoded')
        }

        // obtains signing keys from discovery endpoint
        let keys;

        try {
            keys = await this.getSigningKeys(decodedToken.header);        
        } catch (error) {
            console.log('Signing keys cannot be obtained');
            console.log(error);
        }

   
        // verify the signature at header section using keys
        const verifiedToken = jwt.verify(accessToken, keys);

        if (!verifiedToken) {
            throw new Error('Token cannot be verified');
        }

        /**
         * Validate the token with respect to issuer, audience, scope
         * and timestamp, though implementation and extent vary. For more information, visit:
         * https://docs.microsoft.com/azure/active-directory/develop/access-tokens#validating-tokens
         */
        const checkIssuer = verifiedToken['iss'].includes(this.rawConfig.credentials.tenantId) ? true : false;
        const checkTimestamp = verifiedToken["iat"] <= now && verifiedToken["exp"] >= now ? true : false;
        const checkAudience = verifiedToken['aud'] === this.rawConfig.credentials.clientId || verifiedToken['aud'] === 'api://' + this.rawConfig.credentials.clientId ? true : false;
        const checkScope = this.rawConfig.protected.find(item => item.route === req.route.path).scopes
            .every(scp => verifiedToken['scp'].includes(scp));

        if (checkAudience && checkIssuer && checkTimestamp && checkScope) {

            // token claims will be available in the request for the controller
            req.authInfo = verifiedToken;
            return true;
        }
        return false;
    };
    
    /**
     * Fetches signing keys of an access token 
     * from the authority discovery endpoint
     * @param {String} header 
     * @param {Function} callback 
     */
    getSigningKeys = async(header) => {
        let jwksUri;

        // TODO: Check if a B2C application
        if (this.rawConfig.hasOwnProperty('policies')) {
            jwksUri = `${this.msalConfig.auth.authority}/discovery/v2.0/keys`
        } else {
            jwksUri =`${constants.AuthorityStrings.AAD}${this.rawConfig.credentials.tenantId}/discovery/v2.0/keys`
        }

        const client = jwksClient({
            jwksUri: jwksUri
        });

        return (await client.getSigningKeyAsync(header.kid)).getPublicKey();
    };

    /**
     * This fetches the resource with axios
     * @param {String} endpoint: resource endpoint
     * @param {String} accessToken: raw token
     */
    callAPI = async(endpoint, accessToken) => {

        if (!accessToken || accessToken === "") {
            throw new Error('No tokens found')
        }
        
        const options = {
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        };
        
        console.log('request made to web API at: ' + new Date().toString());

        try {
            const response = await axios.default.get(endpoint, options);
            return response.data;
        } catch(error) {
            console.log(error)
            return error;
        }
    };

    /**
     * This method is used to generate an auth code request
     * @param {String} authority: the authority to request the auth code from 
     * @param {Array} scopes: scopes to request the auth code for 
     * @param {String} state: state of the application
     * @param {String} redirect: redirect URI
     * @param {Object} req: express request object
     * @param {Object} res: express response object
     */
    getAuthCode = async(authority, scopes, state, redirect, req, res) => {
        // prepare the request
        req.session.authCodeRequest.authority = authority;
        req.session.authCodeRequest.scopes = scopes;
        req.session.authCodeRequest.state = state;
        req.session.authCodeRequest.redirectUri = redirect;

        req.session.tokenRequest.authority = authority;

        // request an authorization code to exchange for tokens

        try {
            const response = await this.msalClient.getAuthCodeUrl(req.session.authCodeRequest);
            return res.redirect(response);
        } catch(error) {
            console.log(JSON.stringify(error));
            return res.status(500).send(error);
        }
    };

    /**
     * Util method to get the resource name for a given callingPageRoute (auth.json)
     * @param {String} path: /path string that the resource is associated with 
     */
    getResourceName = (path) => {
        let index = Object.values(this.rawConfig.resources).findIndex(resource => resource.callingPageRoute === path);
        let resourceName = Object.keys(this.rawConfig.resources)[index];
        return resourceName;
    }

}

module.exports = MsalNodeWrapper;