import * as SplashScreen from 'expo-splash-screen';
import {initialize} from './Setup';
import React, {useCallback, useEffect, useState} from 'react';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {NavigationContainer} from '@react-navigation/native';
import * as Font from 'expo-font';
import * as FileSystem from "expo-file-system";
import {StatusBar} from 'expo-status-bar';
import {RecoilRoot} from 'recoil';
import {AppOverviewComponent} from './src/components/root/AppOverviewComponent';
import {AuthenticationComponent} from "./src/components/root/auth/AuthenticationComponent";
import {RootStackParamList} from "./src/models/props/RootProps";
import {PaperProvider, useTheme} from "react-native-paper";
import {Cache} from "aws-amplify";
import {Spinner} from "./src/components/common/Spinner";
import * as Notifications from 'expo-notifications';
import {AndroidNotificationPriority, ExpoPushToken} from 'expo-notifications';
import Constants from "expo-constants";
import {Platform, Text, TextInput, View} from "react-native";
import * as Device from 'expo-device';
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from 'expo-location';
import {LocationObject} from 'expo-location';
import {Image} from 'expo-image';
import * as envInfo from "./local-env-info.json";
import {logEvent} from "./src/utils/AppSync";
import {LoggingLevel, Stages} from "@moonbeam/moonbeam-models";
import * as Updates from 'expo-updates';
import {enableScreens} from "react-native-screens";
import * as TaskManager from "expo-task-manager";
import * as BackgroundFetch from 'expo-background-fetch';
import {receiveBackgroundLocationUpdates} from './src/utils/Permissions';

/**
 * name of the task to register for receiving periodic background updates for location
 * through background fetch.
 *
 * This is to be generally used only when the app is in the Background, and/or when the
 * app is killed (for Android only).
 */
const LOCATION_BACKGROUND_FETCH_TASK_NAME = `LOCATION_BACKGROUND_FETCH_TASK_NAME`;
/**
 * name of the task to register for receiving periodic background location updates.
 *
 * This is to be generally used when the app is in the Background for both iOS
 * and/or Android, but not after the app is killed.
 */
const LOCATION_BACKGROUND_UPDATES_TASK = `LOCATION_BACKGROUND_UPDATES_TASK`;
/**
 * constant used to keep track of the time elapsed since the last
 * background location subscription update
 */
let timeToSendBackgroundUpdate = 0;
/**
 * constant used to keep track of the time elapsed since the last
 * foreground location subscription update
 */
let timeToSendForegroundUpdate = 0;

// Task definition for the task used for receiving background location updates from the Background Fetch task
TaskManager.defineTask(LOCATION_BACKGROUND_FETCH_TASK_NAME, async () => {
    const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Highest,
        distanceInterval: 0, // minimum change (in meters) between updates
        timeInterval: 3000, // only Android
    });

    // store the location captured
    let pushToken: ExpoPushToken = {
        type: 'expo',
        data: ''
    };
    if (envInfo.envName !== Stages.DEV) {
        pushToken = await Notifications.getExpoPushTokenAsync({
            projectId: Constants.expoConfig && Constants.expoConfig.extra ? Constants.expoConfig.extra.eas.projectId : '',
        });
    }
    console.log(`Incoming background fetch location update received: ${JSON.stringify({
        token: pushToken,
        location: JSON.stringify(location)
    })}`);

    // Return the successful result type here
    return BackgroundFetch.BackgroundFetchResult.NewData;
});

// Task definition for the task used for receiving foreground location updates from the Background Fetch task
TaskManager.defineTask(LOCATION_BACKGROUND_UPDATES_TASK, async ({data, error}) => {
    if (error) {
        const errorMessage = `Error while receiving Background location updates ${error.message}`;
        console.log(errorMessage);
        logEvent(errorMessage, LoggingLevel.Warning, false).then(() => {
        });
        return;
    }
    if (data) {
        // @ts-ignore
        const {locations} = data;

        /**
         * calculate the time between this update and the next one
         * to ensure that we do not send updates more often than every 5 seconds.
         */
        const currentTime = Date.now();
        const timeToSend = currentTime - timeToSendBackgroundUpdate;
        if (timeToSend > 5000) {
            // store the location captured
            let pushToken: ExpoPushToken = {
                type: 'expo',
                data: ''
            };
            if (envInfo.envName !== Stages.DEV) {
                pushToken = await Notifications.getExpoPushTokenAsync({
                    projectId: Constants.expoConfig && Constants.expoConfig.extra ? Constants.expoConfig.extra.eas.projectId : '',
                });
            }
            console.log(`Incoming Background location update received: ${JSON.stringify({
                token: pushToken,
                location: JSON.stringify(locations)
            })}`);

            timeToSendBackgroundUpdate = currentTime;
        }
    }
});

// this handler determines how your app handles notifications that come in while the app is foregrounded.
Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
        priority: AndroidNotificationPriority.MAX
    }),
});

/**
 * Function used to check for Expo Updates available over the air
 * (instead of having to actually deploy the app all the time).
 *
 * @returns a {@link Promise} of {@link void} since there is nothing to return here.
 */
async function onFetchUpdateAsync(): Promise<void> {
    try {
        // check for any available updates
        const update = await Updates.checkForUpdateAsync();

        // is any updates are available, then update app accordingly
        if (update.isAvailable) {
            // fetch the update in local storage
            await Updates.fetchUpdateAsync();
            // reload the app asynchronously
            await Updates.reloadAsync();
        }
    } catch (error) {
        const errorMessage = `Error fetching latest Expo update: ${error}`;
        console.log(errorMessage);
        await logEvent(errorMessage, LoggingLevel.Error, false);
    }
}

/**
 * Function used to register the app for async push notifications, and return
 * an expo push token, associated to this user's physical device.
 *
 * @returns a {@link ExpoPushToken} expo push token to be return for this user's
 * physical device.
 */
async function registerForPushNotificationsAsync(): Promise<ExpoPushToken> {
    // expo push token to be returned
    let token: ExpoPushToken = {
        type: 'expo',
        data: ''
    };
    // check to see if this is a physical device first
    if (Device.isDevice) {
        const {status: existingStatus} = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;
        if (existingStatus !== 'granted') {
            const {status} = await Notifications.requestPermissionsAsync();
            finalStatus = status;
        }
        if (finalStatus !== 'granted') {
            const errorMessage = 'Failed to get push token for push notification!';
            console.log(errorMessage);
            await logEvent(errorMessage, LoggingLevel.Error, false);
            return token;
        }
        token = (
            await Notifications.getExpoPushTokenAsync({
                projectId: Constants.expoConfig && Constants.expoConfig.extra ? Constants.expoConfig.extra.eas.projectId : '',
            })
        );
        const message = 'Device set up for notifications';
        console.log(message);
        await logEvent(message, LoggingLevel.Info, false);
    } else {
        const errorMessage = 'Must use physical device for Push Notifications';
        console.log(errorMessage);
        await logEvent(errorMessage, LoggingLevel.Error, false);
    }
    // further configure the push notification for Android only
    if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('default', {
            name: 'default',
            importance: Notifications.AndroidImportance.MAX,
            vibrationPattern: [0, 250, 250, 250],
            lightColor: '#F2FF5D',
            sound: 'default',
            showBadge: true,
            enableVibrate: true
        });
    }
    return token;
}

// keep the splash screen visible while we fetch resources
SplashScreen.preventAutoHideAsync().then(_ => {
});

// initialize the application according to the current Amplify environment
initialize();

/**
 * App component, representing the main application entrypoint.
 *
 * @constructor constructor for the component.
 */
export default function App() {
    // Setting up the  theme to be used in application
    const theme = useTheme();
    theme.colors.secondaryContainer = 'transparent';
    theme.colors.onSurfaceVariant = '#FFFFFF';

    // constants used to keep track of local component state
    const [appLoaded, setIsAppLoaded] = useState<boolean>(false);
    const [deviceSetForNotifications, setDeviceIsSetForNotifications] = useState<boolean>(false);
    const [currentUserLocation, setCurrentUserLocation] = useState<LocationObject | null>(null);
    const [marketplaceCache, setMarketplaceCache] = useState<typeof Cache | null>(null);
    const [cache, setCache] = useState<typeof Cache | null>(null);
    const [loadingSpinnerShown, setLoadingSpinnerShown] = useState<boolean>(true);
    const [appIsReady, setAppIsReady] = useState<boolean>(false);
    const [expoPushToken, setExpoPushToken] = useState<ExpoPushToken>({
        type: 'expo',
        data: ''
    });

    /**
     * Function used to trigger the location permissions used for
     * getting location updates in the Foreground and/or Background.
     */
    const triggerLocationPermissions = async () => {
        // set the current user's position accordingly
        if (currentUserLocation === null) {
            const foregroundPermissionStatus = await Location.requestForegroundPermissionsAsync();
            if (foregroundPermissionStatus.status !== 'granted') {
                const errorMessage = `Permission to access Foreground Location was not granted!`;
                console.log(errorMessage);
                logEvent(errorMessage, LoggingLevel.Warning, false).then(() => {
                });
                setCurrentUserLocation(null);
            } else {
                const errorMessage = `Permission to access Foreground Location was granted!`;
                console.log(errorMessage);
                logEvent(errorMessage, LoggingLevel.Info, false).then(() => {
                });
                const lastKnownPositionAsync: LocationObject | null = await Location.getLastKnownPositionAsync();
                setCurrentUserLocation(lastKnownPositionAsync !== null ? lastKnownPositionAsync : await Location.getCurrentPositionAsync());

                // subscribe to receiving location updates when app is in the Foreground
                await Location.watchPositionAsync({
                    accuracy: Location.Accuracy.Highest,
                    distanceInterval: 0, // minimum change (in meters) between updates
                    timeInterval: 3000, // only Android
                }, async location => {
                    /**
                     * calculate the time between this update and the next one
                     * to ensure that we do not send updates more often than every 5 seconds.
                     */
                    const currentTime = Date.now();
                    const timeToSend = currentTime - timeToSendForegroundUpdate;
                    if (timeToSend > 5000) {
                        // store the location captured
                        console.log(`Incoming Foreground location update received: ${JSON.stringify({
                            token: await Notifications.getExpoPushTokenAsync({
                                projectId: Constants.expoConfig && Constants.expoConfig.extra ? Constants.expoConfig.extra.eas.projectId : '',
                            }),
                            location: JSON.stringify(location)
                        })}`);
                        timeToSendForegroundUpdate = currentTime;
                    }
                });
            }
        }

        // ask for the user's permission to track background location
        const backgroundPermissionStatus = await Location.requestBackgroundPermissionsAsync();
        if (backgroundPermissionStatus.status !== 'granted') {
            const errorMessage = `Permission to access Background Location was not granted!`;
            console.log(errorMessage);
            logEvent(errorMessage, LoggingLevel.Warning, false).then(() => {
            });
        } else {
            const errorMessage = `Permission to access Background Location was granted!`;
            console.log(errorMessage);
            logEvent(errorMessage, LoggingLevel.Info, false).then(() => {
            });

            // startup/register the background location fetch task
            startupBackgroundFetchLocationTask().then(() => {
                // startups/register the background location subscription task
                receiveBackgroundLocationUpdates(LOCATION_BACKGROUND_UPDATES_TASK).then(() => {
                });
            });
        }
    }

    /**
     * Function used to register and startup the task used to capture the user's location
     * when the app is in the background.
     */
    const startupBackgroundFetchLocationTask = async () => {
        const isBackgroundFetchTaskRegistered = await TaskManager.isTaskRegisteredAsync(LOCATION_BACKGROUND_FETCH_TASK_NAME);
        // if the task is already registered, unregister it first before registering it again
        if (isBackgroundFetchTaskRegistered) {
            BackgroundFetch.unregisterTaskAsync(LOCATION_BACKGROUND_FETCH_TASK_NAME).then(() => {
                // register the fetch of the Background location through BackgroundFetch
                BackgroundFetch.registerTaskAsync(LOCATION_BACKGROUND_FETCH_TASK_NAME, {
                    minimumInterval: 30, // do this every 15 minutes
                    stopOnTerminate: false, // android only,
                    startOnBoot: true, // android only
                }).then(() => {
                });
            });
        } else {
            // register the fetch of the Background location through BackgroundFetch
            BackgroundFetch.registerTaskAsync(LOCATION_BACKGROUND_FETCH_TASK_NAME, {
                minimumInterval: 30, // do this every 15 minutes
                stopOnTerminate: false, // android only,
                startOnBoot: true, // android only
            }).then(() => {
            });
        }
    }

    /**
     * Entrypoint UseEffect will be used as a block of code where we perform specific tasks (such as
     * auth-related functionality for example), as well as any afferent API calls.
     *
     * Generally speaking, any functionality imperative prior to the full page-load should be
     * included in here.
     */
    useEffect(() => {
        const prepare = async () => {
            try {
                // preload fonts, make any API calls that we need in here
                // preloading all Raleway fonts
                await Font.loadAsync({
                    'Changa-Bold': require('./assets/fonts/Changa/static/Changa-Bold.ttf'),
                    'Changa-ExtraBold': require('./assets/fonts/Changa/static/Changa-ExtraBold.ttf'),
                    'Changa-ExtraLight': require('./assets/fonts/Changa/static/Changa-ExtraLight.ttf'),
                    'Changa-Light': require('./assets/fonts/Changa/static/Changa-Light.ttf'),
                    'Changa-Medium': require('./assets/fonts/Changa/static/Changa-Medium.ttf'),
                    'Changa-Regular': require('./assets/fonts/Changa/static/Changa-Regular.ttf'),
                    'Changa-SemiBold': require('./assets/fonts/Changa/static/Changa-SemiBold.ttf'),
                    'Saira-Bold': require('./assets/fonts/Saira/static/Saira-Bold.ttf'),
                    'Saira-ExtraBold': require('./assets/fonts/Saira/static/Saira-ExtraBold.ttf'),
                    'Saira-ExtraLight': require('./assets/fonts/Saira/static/Saira-ExtraLight.ttf'),
                    'Saira-Light': require('./assets/fonts/Saira/static/Saira-Light.ttf'),
                    'Saira-Medium': require('./assets/fonts/Saira/static/Saira-Medium.ttf'),
                    'Saira-Regular': require('./assets/fonts/Saira/static/Saira-Regular.ttf'),
                    'Saira-SemiBold': require('./assets/fonts/Saira/static/Saira-SemiBold.ttf'),
                    'Raleway-Bold': require('./assets/fonts/Raleway/static/Raleway-Bold.ttf'),
                    'Raleway-ExtraBold': require('./assets/fonts/Raleway/static/Raleway-ExtraBold.ttf'),
                    'Raleway-ExtraLight': require('./assets/fonts/Raleway/static/Raleway-ExtraLight.ttf'),
                    'Raleway-Light': require('./assets/fonts/Raleway/static/Raleway-Light.ttf'),
                    'Raleway-Medium': require('./assets/fonts/Raleway/static/Raleway-Medium.ttf'),
                    'Raleway-Regular': require('./assets/fonts/Raleway/static/Raleway-Regular.ttf'),
                    'Raleway-SemiBold': require('./assets/fonts/Raleway/static/Raleway-SemiBold.ttf'),
                });
            } catch (e) {
                console.warn(e);
            } finally {
                // clean the file system cache
                await FileSystem.deleteAsync(`${FileSystem.documentDirectory!}` + `files`, {
                    idempotent: true
                });

                // prepare the application for notifications
                if (envInfo.envName !== Stages.DEV && !deviceSetForNotifications) {
                    setDeviceIsSetForNotifications(true);
                    setExpoPushToken(await registerForPushNotificationsAsync());
                }

                // wait for incoming over the air updates and act accordingly
                if (envInfo.envName !== Stages.DEV && Updates.channel !== undefined &&
                    Updates.channel !== null && Updates.channel === "production") {
                    await onFetchUpdateAsync();
                }

                // configure the Global Cache - @link https://docs.amplify.aws/lib/utilities/cache/q/platform/js/#api-reference
                // @ts-ignore
                setCache(Cache.createInstance({
                    keyPrefix: 'global-amplify-cache',
                    capacityInBytes: 5000000, // 5 MB max cache size
                    itemMaxSize: 500000, // 500 KB max per item
                    defaultTTL: 18000000, // in milliseconds, about 48 hours (we also have request/response caching every hour)
                    warningThreshold: 0.8, // when to get warned that the cache is full, at 80% capacity
                    storage: AsyncStorage
                }));

                // configure the Marketplace specific Cache - @link https://docs.amplify.aws/lib/utilities/cache/q/platform/js/#api-reference
                // @ts-ignore
                setMarketplaceCache(Cache.createInstance({
                    keyPrefix: 'marketplace-amplify-cache',
                    capacityInBytes: 5000000, // 5 MB max cache size
                    itemMaxSize: 2500000, // 2.5 MB max per item
                    defaultTTL: 18000000, // in milliseconds, about 5 hours (we also have request/response caching every hour)
                    warningThreshold: 0.8, // when to get warned that the cache is full, at 80% capacity
                    storage: AsyncStorage
                }));

                // disable the Text scaling for the entire application
                // @ts-ignore
                Text.defaultProps = Text.defaultProps || {};
                // @ts-ignore
                Text.defaultProps.allowFontScaling = false;
                // @ts-ignore
                TextInput.defaultProps = TextInput.defaultProps || {};
                // @ts-ignore
                TextInput.defaultProps.allowFontScaling = false;

                // clear previous disk and memory images cache
                await Image.clearDiskCache();
                await Image.clearMemoryCache();

                // trigger the location permissions and configure them for receiving location updates
                triggerLocationPermissions().then(() => {
                    // tell the application to render
                    setAppIsReady(true);
                });
            }
        }
        // prepare the app
        if (!appLoaded) {
            setIsAppLoaded(true);
            prepare().then(() => {
            });
        }
        /**
         * {@link https://github.com/react-navigation/react-navigation/issues/10432}
         */
        if (Platform.OS === "ios") {
            enableScreens(false);
        }

        return () => {
            // whenever we exit the app, we want to unregister the location subscription tasks
            TaskManager.isTaskRegisteredAsync(LOCATION_BACKGROUND_UPDATES_TASK).then(isBackgroundLocationSubscriptionTaskRegistered => {
                isBackgroundLocationSubscriptionTaskRegistered &&
                TaskManager.unregisterTaskAsync(LOCATION_BACKGROUND_UPDATES_TASK).then(() => {
                });
            });
        };
    }, [currentUserLocation, deviceSetForNotifications]);

    /**
     * Invoked when the application is mounted and the layout changes
     */
    const onLayoutRootView = useCallback(async () => {
        if (appIsReady) {
            // artificially delay for 1 seconds to simulate loading experience.
            await new Promise(resolve => setTimeout(resolve, 1000));
            await SplashScreen.hideAsync();
        }
    }, [appIsReady]);

    if (!appIsReady) {
        return null;
    } else {
        // create a native stack navigator, to be used for our root application navigation
        const RootStack = createNativeStackNavigator<RootStackParamList>();

        // return the main component for the application stack
        return (
            <RecoilRoot>
                <PaperProvider theme={theme}>
                    <StatusBar style="light" animated={true}/>
                    <View style={{flex: 1, backgroundColor: '#313030'}}>
                        <NavigationContainer
                            fallback={
                                <Spinner loadingSpinnerShown={loadingSpinnerShown}
                                         setLoadingSpinnerShown={setLoadingSpinnerShown}/>
                            } independent={true}>
                            <RootStack.Navigator
                                initialRouteName={"AppOverview"}
                                screenOptions={{
                                    headerShown: false,
                                    gestureEnabled: false
                                }}
                            >
                                <RootStack.Screen
                                    name="AppOverview"
                                    component={AppOverviewComponent}
                                    initialParams={{
                                        marketplaceCache: marketplaceCache!,
                                        cache: cache!,
                                        currentUserLocation: currentUserLocation,
                                        expoPushToken: expoPushToken,
                                        onLayoutRootView: onLayoutRootView
                                    }}
                                />
                                <RootStack.Screen
                                    name="Authentication"
                                    component={AuthenticationComponent}
                                    initialParams={{
                                        marketplaceCache: marketplaceCache!,
                                        cache: cache!,
                                        currentUserLocation: currentUserLocation,
                                        expoPushToken: expoPushToken,
                                        onLayoutRootView: onLayoutRootView,
                                    }}
                                />
                            </RootStack.Navigator>
                        </NavigationContainer>
                    </View>
                </PaperProvider>
            </RecoilRoot>
        );
    }
}
