import {requestTrackingPermissionsAsync} from "expo-tracking-transparency";
import {logEvent} from "./AppSync";
import {LoggingLevel} from "@moonbeam/moonbeam-models";
import * as Location from 'expo-location';
import {LocationActivityType} from 'expo-location';
import * as TaskManager from "expo-task-manager";

/**
 * Function used to add the necessary app tracking transparency permissions,
 * needed for iOS devices.
 */
export const requestAppTrackingTransparencyPermission = async () => {
    setTimeout(async () => {
        const {status} = await requestTrackingPermissionsAsync();
        if (status !== 'granted') {
            const message = 'Permission to track your data not granted!';
            console.log(message);
            await logEvent(message, LoggingLevel.Info, false);
        }
    }, 1500);
}

/**
 * Function used to start receiving location updates in the background.
 */
export const receiveBackgroundLocationUpdates = async (taskName: string): Promise<void> => {
    const isBackgroundUpdatesTaskRegistered = await TaskManager.isTaskRegisteredAsync(taskName);
    // if the task is already registered, unregister it first before registering it again
    if (isBackgroundUpdatesTaskRegistered) {
        await Location.stopLocationUpdatesAsync(taskName);

        // used for registering a task in the App.tsx that will capture the Location updates subscription.
        await Location.startLocationUpdatesAsync(taskName, {
            accuracy: Location.Accuracy.Highest,
            distanceInterval: 0, // minimum change (in meters) between updates
            timeInterval: 3000, // only Android
            pausesUpdatesAutomatically: true, // only iOS
            activityType: LocationActivityType.AutomotiveNavigation, // needed for pausesUpdatesAutomatically
        });
    } else {
        // used for registering a task in the App.tsx that will capture the Location updates subscription.
        await Location.startLocationUpdatesAsync(taskName, {
            accuracy: Location.Accuracy.Highest,
            distanceInterval: 0, // minimum change (in meters) between updates
            timeInterval: 3000, // only Android
            pausesUpdatesAutomatically: true, // only iOS
            activityType: LocationActivityType.AutomotiveNavigation, // needed for pausesUpdatesAutomatically
        });
    }
};
